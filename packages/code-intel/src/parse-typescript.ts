import ts from "typescript";
import type { ParseFileResult, ParsedRelationship, ParsedSymbol } from "./types.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const SIGNAL_FACTORIES = new Set(["signal", "input", "output", "model"]);

interface ClassContext {
  name: string;
  kind: "angular_service" | "component" | "class";
  httpReceivers: Set<string>;
}

export function parseTypeScriptFile(opts: { filePath: string; sourceText: string }): ParseFileResult {
  const { filePath, sourceText } = opts;
  const sf = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const symbols: ParsedSymbol[] = [];
  const relationships: ParsedRelationship[] = [];
  const errors: string[] = [];

  const diagnostics = (sf as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  for (const d of diagnostics) {
    const { line } = sf.getLineAndCharacterOfPosition(d.start);
    errors.push(`${filePath}:${line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
  }

  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      handleClass(node, node.name.text);
      return;
    }
    if (ts.isInterfaceDeclaration(node) && hasExport(node)) {
      const properties = interfacePropertyNames(node);
      symbols.push({
        symbolType: "interface",
        symbolName: node.name.text,
        filePath,
        lineStart: lineOf(node.getStart(sf)),
        lineEnd: lineOf(node.getEnd()),
        signature: header(node),
        metadata: { members: properties.length, properties },
      });
    }
    ts.forEachChild(node, visit);
  };

  function interfacePropertyNames(node: ts.InterfaceDeclaration): string[] {
    const names: string[] = [];
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.name) continue;
      if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) {
        names.push(member.name.text);
      }
    }
    return names;
  }

  function hasExport(node: ts.Node): boolean {
    return (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    );
  }

  function header(node: ts.ClassDeclaration | ts.InterfaceDeclaration): string {
    const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
    const start = decorators.length > 0 ? decorators[decorators.length - 1].getEnd() : node.getStart(sf);
    return sourceText
      .slice(start, node.members.pos - 1)
      .replace(/\s+/g, " ")
      .trim();
  }

  function decoratorsOf(node: ts.Node): ts.Decorator[] {
    return ts.canHaveDecorators(node) ? [...(ts.getDecorators(node) ?? [])] : [];
  }

  function decoratorName(d: ts.Decorator): string | undefined {
    const e = d.expression;
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) return e.expression.text;
    if (ts.isIdentifier(e)) return e.text;
    return undefined;
  }

  function decoratorObjectArg(d: ts.Decorator): ts.ObjectLiteralExpression | undefined {
    const e = d.expression;
    if (ts.isCallExpression(e) && e.arguments[0] && ts.isObjectLiteralExpression(e.arguments[0])) {
      return e.arguments[0];
    }
    return undefined;
  }

  function stringProp(obj: ts.ObjectLiteralExpression | undefined, name: string): string | undefined {
    if (!obj) return undefined;
    for (const p of obj.properties) {
      if (
        ts.isPropertyAssignment(p) &&
        (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
        p.name.text === name &&
        ts.isStringLiteralLike(p.initializer)
      ) {
        return p.initializer.text;
      }
    }
    return undefined;
  }

  function typeName(t: ts.TypeNode | undefined): string | undefined {
    if (t && ts.isTypeReferenceNode(t)) return t.typeName.getText(sf);
    return undefined;
  }

  /** Name of the callee if `expr` is `name(...)`, `name<T>(...)`, or `name.required(...)`. */
  function factoryCall(expr: ts.Expression | undefined): { name: string; call: ts.CallExpression } | undefined {
    if (!expr || !ts.isCallExpression(expr)) return undefined;
    const callee = expr.expression;
    if (ts.isIdentifier(callee)) return { name: callee.text, call: expr };
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
      return { name: callee.expression.text, call: expr };
    }
    return undefined;
  }

  function handleClass(node: ts.ClassDeclaration, className: string): void {
    const decorators = decoratorsOf(node);
    const names = decorators.map(decoratorName);
    const isInjectable = names.includes("Injectable");
    const componentDecorator = decorators.find((d) => decoratorName(d) === "Component");
    const kind: ClassContext["kind"] = componentDecorator ? "component" : isInjectable ? "angular_service" : "class";
    const ctx: ClassContext = { name: className, kind, httpReceivers: new Set() };

    const injected: Array<{ type: string; pos: number }> = [];
    const inputs: string[] = [];
    const outputs: string[] = [];
    const signalSymbols: ParsedSymbol[] = [];

    for (const member of node.members) {
      if (ts.isConstructorDeclaration(member)) {
        for (const p of member.parameters) {
          const t = typeName(p.type);
          if (!t) continue;
          injected.push({ type: t, pos: p.getStart(sf) });
          if (t === "HttpClient" && ts.isIdentifier(p.name)) ctx.httpReceivers.add(p.name.text);
        }
      } else if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) {
        const prop = member.name.text;
        const f = factoryCall(member.initializer);
        const t = typeName(member.type);
        if (t === "HttpClient") ctx.httpReceivers.add(prop);
        if (f?.name === "inject") {
          const arg = f.call.arguments[0];
          if (arg && ts.isIdentifier(arg)) {
            injected.push({ type: arg.text, pos: member.getStart(sf) });
            if (arg.text === "HttpClient") ctx.httpReceivers.add(prop);
          }
        }
        const memberDecos = decoratorsOf(member).map(decoratorName);
        if (memberDecos.includes("Input")) inputs.push(prop);
        if (memberDecos.includes("Output")) outputs.push(prop);

        if (f && SIGNAL_FACTORIES.has(f.name)) {
          if (f.name === "input" || f.name === "model") inputs.push(prop);
          if (f.name === "output" || f.name === "model") outputs.push(prop);
          const mods = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : [];
          const isPrivate = mods.some(
            (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
          );
          if (!isPrivate) {
            signalSymbols.push({
              symbolType: "signal",
              symbolName: `${className}.${prop}`,
              filePath,
              lineStart: lineOf(member.getStart(sf)),
              lineEnd: lineOf(member.getEnd()),
              signature: member.getText(sf).replace(/\s+/g, " ").trim(),
              metadata: { kind: f.name, owner: className },
            });
          }
        }
      }
    }

    if (kind !== "class") {
      const metadata: Record<string, unknown> = {};
      if (componentDecorator) {
        const selector = stringProp(decoratorObjectArg(componentDecorator), "selector");
        if (selector) metadata.selector = selector;
        if (inputs.length > 0) metadata.inputs = inputs;
        if (outputs.length > 0) metadata.outputs = outputs;
      }
      symbols.push({
        symbolType: kind,
        symbolName: className,
        filePath,
        lineStart: lineOf(node.getStart(sf)),
        lineEnd: lineOf(node.getEnd()),
        signature: header(node),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
      for (const inj of injected) {
        relationships.push({
          sourceName: className,
          sourceType: kind,
          targetName: inj.type,
          relationshipType: "injects",
          filePath,
          lineStart: lineOf(inj.pos),
        });
      }
    }
    symbols.push(...signalSymbols);

    if (ctx.httpReceivers.size > 0) {
      for (const member of node.members) findHttpCalls(member, ctx, memberName(member));
    }
  }

  function memberName(member: ts.ClassElement): string {
    if (ts.isConstructorDeclaration(member)) return "constructor";
    return member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) ? member.name.text : "<anonymous>";
  }

  function pathFromArg(arg: ts.Expression | undefined): string | undefined {
    if (!arg) return undefined;
    if (ts.isStringLiteralLike(arg)) return arg.text;
    if (ts.isTemplateExpression(arg)) {
      let out = arg.head.text;
      for (const span of arg.templateSpans) out += `\${${span.expression.getText(sf)}}${span.literal.text}`;
      return out;
    }
    return undefined;
  }

  function findHttpCalls(root: ts.Node, ctx: ClassContext, method: string): void {
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const callee = node.expression;
        const verb = callee.name.text;
        const recv = callee.expression;
        const recvName =
          ts.isPropertyAccessExpression(recv) && recv.expression.kind === ts.SyntaxKind.ThisKeyword
            ? recv.name.text
            : ts.isIdentifier(recv)
              ? recv.text
              : undefined;
        if (HTTP_METHODS.has(verb) && recvName && ctx.httpReceivers.has(recvName)) {
          const path = pathFromArg(node.arguments[0]);
          if (path !== undefined) {
            const httpMethod = verb.toUpperCase();
            const line = lineOf(node.getStart(sf));
            const sourceName = `${ctx.name}.${method}`;
            symbols.push({
              symbolType: "http_call",
              symbolName: `${httpMethod} ${path}`,
              filePath,
              lineStart: line,
              lineEnd: lineOf(node.getEnd()),
              signature: node.getText(sf).split("\n")[0].trim(),
              metadata: { httpMethod, path, caller: sourceName },
            });
            relationships.push({
              sourceName,
              sourceType: "service_method",
              targetName: path,
              relationshipType: "http_calls",
              filePath,
              lineStart: line,
            });
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(root);
  }

  visit(sf);
  return { symbols, relationships, errors };
}
