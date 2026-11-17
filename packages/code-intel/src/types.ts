import type { RelationshipType, SymbolType } from "@review/shared";

export interface ParsedSymbol {
  symbolType: SymbolType;
  symbolName: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  signature: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface ParsedRelationship {
  sourceName: string;
  sourceType: SymbolType;
  targetName: string;
  relationshipType: RelationshipType;
  filePath: string;
  lineStart: number;
}

export interface ParseFileResult {
  symbols: ParsedSymbol[];
  relationships: ParsedRelationship[];
  errors: string[];
}
