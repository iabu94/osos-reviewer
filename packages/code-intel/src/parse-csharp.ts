import Parser from "tree-sitter";
import CSharp from "tree-sitter-c-sharp";
import type { SymbolType } from "@review/shared";
import type { ParseFileResult, ParsedRelationship, ParsedSymbol } from "./types.js";

type Node = Parser.SyntaxNode;

const HTTP_ATTRIBUTES: Record<string, string> = {
  HttpGet: "GET",
  HttpPost: "POST",
  HttpPut: "PUT",
  HttpDelete: "DELETE",
  HttpPatch: "PATCH",
  HttpHead: "HEAD",
  HttpOptions: "OPTIONS",
};

const TYPE_DECLARATIONS = new Set([
  "class_declaration",
  "record_declaration",
  "record_struct_declaration",
  "struct_declaration",
]);

let cachedParser: Parser | undefined;

/** Lazily initialise the tree-sitter C# language once per process. */
function getParser(): Parser {
  if (!cachedParser) {
    const parser = new Parser();
    parser.setLanguage(CSharp as Parameters<Parser["setLanguage"]>[0]);
    cachedParser = parser;
  }
  return cachedParser;
}

interface AttributeInfo {
  name: string;
  /** Positional (unnamed) string-literal arguments, in order. */
  args: string[];
}

export function parseCSharpFile(opts: { filePath: string; sourceText: string }): ParseFileResult {
  const { filePath, sourceText } = opts;
  const symbols: ParsedSymbol[] = [];
  const relationships: ParsedRelationship[] = [];
  const errors: string[] = [];

  let root: Node;
  try {
    root = getParser().parse(sourceText, undefined, {
      bufferSize: Math.max(32 * 1024, sourceText.length * 2),
    }).rootNode;
  } catch (err) {
    return {
      symbols: [],
      relationships: [],
      errors: [`${filePath}: C# parse failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  if (root.hasError) {
    collectErrors(root, filePath, errors);
    return { symbols: [], relationships: [], errors };
  }

  const emitSymbol = (
    node: Node,
    symbolType: SymbolType,
    symbolName: string,
    metadata?: Record<string, unknown>,
  ): void => {
    symbols.push({
      symbolType,
      symbolName,
      filePath,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      signature: signatureOf(sourceText, node),
      ...(metadata ? { metadata } : {}),
    });
  };

  const emitRel = (
    node: Node,
    sourceName: string,
    sourceType: SymbolType,
    targetName: string,
    relationshipType: ParsedRelationship["relationshipType"],
  ): void => {
    relationships.push({
      sourceName,
      sourceType,
      targetName,
      relationshipType,
      filePath,
      lineStart: node.startPosition.row + 1,
    });
  };

  const handleType = (node: Node): void => {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const name = nameNode.text;
    const attrs = attributesOf(node);
    const bases = baseTypesOf(node);
    const members = membersOf(node);
    const isRecord = node.type === "record_declaration" || node.type === "record_struct_declaration";

    const validatorBase = bases.find((b) => b.name === "AbstractValidator" && b.typeArgs.length === 1);
    const configBases = bases.filter((b) => b.name === "IEntityTypeConfiguration" && b.typeArgs.length === 1);
    const isDbContext = bases.some((b) => b.name === "DbContext" || b.name.endsWith("DbContext"));
    const isController =
      attrs.some((a) => a.name === "ApiController") ||
      name.endsWith("Controller") ||
      bases.some((b) => b.name === "ControllerBase" || b.name === "Controller");

    if (validatorBase) {
      const target = validatorBase.typeArgs[0];
      emitSymbol(node, "validation_rule", name, { validates: target });
      emitRel(node, name, "validation_rule", target, "validates");
    } else if (isDbContext || configBases.length > 0) {
      const entities: string[] = [];
      for (const prop of members.filter((m) => m.type === "property_declaration")) {
        const typeNode = prop.childForFieldName("type");
        const generic = typeNode ? genericOf(typeNode) : undefined;
        if (generic?.name === "DbSet" && generic.typeArgs.length === 1) entities.push(generic.typeArgs[0]);
      }
      const configured = configBases.map((b) => b.typeArgs[0]);
      emitSymbol(node, "dbcontext_config", name, {
        kind: isDbContext ? "dbcontext" : "entity_type_configuration",
        entities: [...entities, ...configured],
      });
      for (const target of [...entities, ...configured]) {
        emitRel(node, name, "dbcontext_config", target, "maps_to");
      }
    } else if (isController) {
      handleController(node, name, attrs, members);
    } else if (name.endsWith("Service")) {
      for (const m of members) {
        if (m.type !== "method_declaration" || !hasModifier(m, "public")) continue;
        const methodName = m.childForFieldName("name")?.text;
        if (!methodName) continue;
        emitSymbol(m, "service_method", `${name}.${methodName}`, { className: name });
      }
    } else if (isRecord || name.endsWith("Dto")) {
      const properties = dtoPropertiesOf(node, isRecord, members);
      emitSymbol(node, "dto", name, {
        kind: isRecord ? "record" : "class",
        properties,
      });
    } else {
      const keys = keyPropertiesOf(name, members);
      if (keys.length > 0) {
        emitSymbol(node, "entity", name, { keys });
      } else if (/models/i.test(filePath)) {
        emitSymbol(node, "dto", name, {
          kind: "class",
          properties: dtoPropertiesOf(node, false, members),
        });
      }
    }

    for (const m of members) {
      if (TYPE_DECLARATIONS.has(m.type)) handleType(m);
    }
  };

  const handleController = (node: Node, name: string, attrs: AttributeInfo[], members: Node[]): void => {
    const controllerToken = name.replace(/Controller$/, "");
    const classRoute = attrs.find((a) => a.name === "Route")?.args[0];
    const classPrefix = classRoute === undefined ? "" : substituteTokens(classRoute, controllerToken);
    emitSymbol(node, "controller", name, { ...(classRoute !== undefined ? { route: classPrefix } : {}) });
    if (classPrefix) emitRel(node, name, "controller", classPrefix, "exposes");

    for (const m of members) {
      if (m.type !== "method_declaration") continue;
      const methodName = m.childForFieldName("name")?.text;
      if (!methodName) continue;
      const mAttrs = attributesOf(m);
      const http = mAttrs.find((a) => a.name in HTTP_ATTRIBUTES);
      if (!http) continue;
      const routeAttr = mAttrs.find((a) => a.name === "Route");
      const template = http.args[0] ?? routeAttr?.args[0];
      const route = combineRoutes(classPrefix, template === undefined ? undefined : substituteTokens(template, controllerToken));
      const endpointName = `${name}.${methodName}`;
      emitSymbol(m, "endpoint", endpointName, { httpMethod: HTTP_ATTRIBUTES[http.name], route, controller: name });
      if (route) emitRel(m, endpointName, "endpoint", route, "exposes");
    }
  };

  const visit = (node: Node): void => {
    if (TYPE_DECLARATIONS.has(node.type)) {
      handleType(node);
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);

  return { symbols, relationships, errors };
}

function collectErrors(root: Node, filePath: string, errors: string[]): void {
  const limit = 5;
  const walk = (node: Node): void => {
    if (errors.length >= limit) return;
    if (node.type === "ERROR" || node.isMissing) {
      const line = node.startPosition.row + 1;
      errors.push(
        node.isMissing
          ? `${filePath}:${line}: syntax error: missing ${node.type}`
          : `${filePath}:${line}: syntax error near "${node.text.slice(0, 40).replace(/\s+/g, " ")}"`,
      );
      return;
    }
    if (!node.hasError) return;
    for (const child of node.children) walk(child);
  };
  walk(root);
  if (errors.length === 0) errors.push(`${filePath}: syntax error`);
}

function signatureOf(source: string, node: Node): string {
  const firstNonAttr = node.children.find((c) => c.type !== "attribute_list");
  const start = firstNonAttr?.startIndex ?? node.startIndex;
  const body = node.childForFieldName("body");
  const end = body ? body.startIndex : node.endIndex;
  return source.slice(start, end).replace(/\s+/g, " ").trim().replace(/;$/, "").trim();
}

function membersOf(node: Node): Node[] {
  const body = node.childForFieldName("body");
  return body ? body.namedChildren : [];
}

function hasModifier(node: Node, modifier: string): boolean {
  return node.children.some((c) => c.type === "modifier" && c.text === modifier);
}

function attributesOf(node: Node): AttributeInfo[] {
  const out: AttributeInfo[] = [];
  for (const list of node.children) {
    if (list.type !== "attribute_list") continue;
    for (const attr of list.namedChildren) {
      if (attr.type !== "attribute") continue;
      const nameNode = attr.childForFieldName("name");
      if (!nameNode) continue;
      const args: string[] = [];
      const argList = attr.namedChildren.find((c) => c.type === "attribute_argument_list");
      for (const arg of argList?.namedChildren ?? []) {
        if (arg.type !== "attribute_argument") continue;
        // Named arguments (`Name = "x"`) expose a name_equals child; skip them.
        if (arg.namedChildren.some((c) => c.type === "name_equals")) continue;
        const lit = arg.namedChildren.find((c) => c.type === "string_literal" || c.type === "verbatim_string_literal");
        if (lit) args.push(stringValue(lit));
      }
      out.push({ name: simpleName(nameNode.text).replace(/Attribute$/, ""), args });
    }
  }
  return out;
}

function stringValue(lit: Node): string {
  const content = lit.namedChildren.find((c) => c.type === "string_literal_content");
  if (content) return content.text;
  return lit.text.replace(/^@?"/, "").replace(/"$/, "");
}

function simpleName(text: string): string {
  const withoutGenerics = text.replace(/<.*$/, "");
  const parts = withoutGenerics.split(".");
  return parts[parts.length - 1];
}

interface TypeRef {
  name: string;
  typeArgs: string[];
}

function genericOf(node: Node): TypeRef | undefined {
  if (node.type === "generic_name") {
    const id = node.namedChildren.find((c) => c.type === "identifier");
    const argList = node.namedChildren.find((c) => c.type === "type_argument_list");
    return {
      name: id?.text ?? simpleName(node.text),
      typeArgs: (argList?.namedChildren ?? []).map((c) => simpleName(c.text)),
    };
  }
  if (node.type === "qualified_name") {
    // Last child is the right-most segment, which may itself be generic.
    const last = node.namedChildren[node.namedChildren.length - 1];
    return last ? genericOf(last) : undefined;
  }
  return { name: simpleName(node.text), typeArgs: [] };
}

function baseTypesOf(node: Node): TypeRef[] {
  const list = node.namedChildren.find((c) => c.type === "base_list");
  if (!list) return [];
  const out: TypeRef[] = [];
  for (const child of list.namedChildren) {
    const ref = genericOf(child.type === "primary_constructor_base_type" ? (child.namedChildren[0] ?? child) : child);
    if (ref) out.push(ref);
  }
  return out;
}

function dtoPropertiesOf(node: Node, isRecord: boolean, members: Node[]): string[] {
  if (isRecord) {
    const params =
      node.childForFieldName("parameter_list") ??
      node.namedChildren.find((c) => c.type === "parameter_list");
    if (!params) return [];
    const names: string[] = [];
    for (const child of params.namedChildren) {
      if (child.type !== "parameter") continue;
      const id = child.childForFieldName("name");
      if (id) names.push(id.text);
    }
    return names;
  }
  const names: string[] = [];
  for (const m of members) {
    if (m.type !== "property_declaration" || !hasModifier(m, "public")) continue;
    const propName = m.childForFieldName("name")?.text;
    if (propName) names.push(propName);
  }
  return names;
}

function keyPropertiesOf(className: string, members: Node[]): string[] {
  const keys: string[] = [];
  for (const m of members) {
    if (m.type !== "property_declaration") continue;
    const propName = m.childForFieldName("name")?.text;
    if (!propName) continue;
    const hasKeyAttr = attributesOf(m).some((a) => a.name === "Key");
    if (hasKeyAttr || propName === "Id" || propName === `${className}Id`) keys.push(propName);
  }
  return keys;
}

/** Replaces ASP.NET `[controller]` route tokens with the controller name sans suffix. */
function substituteTokens(template: string, controllerToken: string): string {
  return template.replace(/\[controller\]/gi, controllerToken);
}

/** Combines a controller route prefix with a method template (ASP.NET rules). */
function combineRoutes(prefix: string, template: string | undefined): string {
  if (template === undefined || template === "") return prefix;
  if (template.startsWith("/") || template.startsWith("~/")) return template.replace(/^~?\//, "");
  if (!prefix) return template;
  return `${prefix.replace(/\/+$/, "")}/${template}`;
}
