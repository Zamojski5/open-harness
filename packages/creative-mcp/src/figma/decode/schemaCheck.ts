// Schema-mismatch diagnostics. The digest, outline and SVG read decoded fields by name, and those
// names are hypotheses about an undocumented format. Instead of quietly producing empty output when
// Figma renames something, compare the names we rely on with the file's own schema and with what
// actually came out, and say loudly what is missing and where to look (schema.txt).

import type { Schema } from "kiwi-schema";
import type { Doc, Raw } from "./model.ts";

/**
 * Field names the readers rely on, by role. `critical` ones break the tree itself; the rest only
 * degrade one feature. Struct/message names are not checked: they are guesses too, and only field
 * names reach our code.
 */
export const EXPECTED_FIELDS: Record<
  string,
  { critical: boolean; feature: string; fields: string[] }
> = {
  tree: {
    critical: true,
    feature: "node list and tree (everything)",
    fields: [
      "nodeChanges",
      "guid",
      "sessionID",
      "localID",
      "parentIndex",
      "position",
      "type",
      "name",
    ],
  },
  geometry: {
    critical: false,
    feature: "boxes and SVG geometry",
    fields: [
      "transform",
      "size",
      "blobs",
      "bytes",
      "fillGeometry",
      "strokeGeometry",
      "commandsBlob",
      "windingRule",
      "vectorData",
      "vectorNetworkBlob",
    ],
  },
  paints: {
    critical: false,
    feature: "colours, gradients, images",
    fields: [
      "fillPaints",
      "strokePaints",
      "color",
      "opacity",
      "visible",
      "stops",
      "image",
      "hash",
      "imageScaleMode",
    ],
  },
  text: {
    critical: false,
    feature: "text content, fonts, glyph outlines",
    fields: [
      "textData",
      "characters",
      "fontName",
      "family",
      "style",
      "fontSize",
      "derivedTextData",
      "glyphs",
    ],
  },
  components: {
    critical: false,
    feature: "instances and overrides",
    fields: ["symbolData", "symbolID", "symbolOverrides", "derivedSymbolData", "guidPath", "guids"],
  },
  styles: { critical: false, feature: "styles", fields: ["styleType"] },
  variables: {
    critical: false,
    feature: "variables and modes",
    fields: ["variableSetModes", "variableDataValues", "variableSetID", "variableResolvedType"],
  },
  prototype: {
    critical: false,
    feature: "prototype links",
    fields: ["prototypeInteractions"],
  },
  paste: {
    critical: false,
    feature: "paste roots and file key (clipboard only)",
    fields: ["clipboardSelectionRegions", "pasteFileKey"],
  },
};

/** Enum values the readers compare against (node types). */
export const EXPECTED_ENUM_VALUES = ["DOCUMENT", "CANVAS", "FRAME", "TEXT", "INSTANCE", "SYMBOL"];

export interface SchemaReport {
  /** Field names (by role) the file's schema does not define. */
  missingFields: Record<string, string[]>;
  missingEnumValues: string[];
  /** A missing name breaks the tree itself, not just one feature. */
  critical: boolean;
}

export function checkSchema(schema: Schema): SchemaReport {
  const fields = new Set<string>();
  const enumValues = new Set<string>();
  for (const d of schema.definitions)
    for (const f of d.fields) (d.kind === "ENUM" ? enumValues : fields).add(f.name);
  const missingFields: Record<string, string[]> = {};
  let critical = false;
  for (const [role, spec] of Object.entries(EXPECTED_FIELDS)) {
    const miss = spec.fields.filter((f) => !fields.has(f));
    if (miss.length) {
      missingFields[role] = miss;
      if (spec.critical) critical = true;
    }
  }
  const missingEnumValues = EXPECTED_ENUM_VALUES.filter((v) => !enumValues.has(v));
  if (missingEnumValues.includes("CANVAS") || missingEnumValues.includes("DOCUMENT"))
    critical = true;
  return { missingFields, missingEnumValues, critical };
}

export interface Diagnostics {
  /** True when anything the digest depends on looks renamed or absent. */
  schemaMismatch: boolean;
  warnings: string[];
  missingFields?: Record<string, string[]>;
  missingEnumValues?: string[];
  hint?: string;
}

export const MISMATCH_HINT =
  "Schema mismatch: digest/outline/SVG field names are hypotheses about Figma's undocumented format. " +
  "Grep schema.txt in this folder for the missing names (or close variants) and report them; " +
  "nodes.jsonl, blobs.jsonl, message.json and schema.txt are complete regardless and can be grepped directly. " +
  "The names live in packages/creative-mcp/src/figma/decode/schemaCheck.ts and the readers in decode/ and svg/.";

/** Combines the schema check with what the decode actually produced. */
export function diagnose(input: {
  schema: Schema;
  message: Raw;
  doc: Doc;
  isPaste: boolean;
  archiveMedia: number;
  referencedImages: number;
}): Diagnostics {
  const { schema, message, doc, isPaste } = input;
  const report = checkSchema(schema);
  const warnings: string[] = [];
  const missing = { ...report.missingFields };
  if (!isPaste) delete missing.paste;
  for (const [role, names] of Object.entries(missing))
    warnings.push(
      `schema has no field ${names.map((n) => `"${n}"`).join(", ")}: ${EXPECTED_FIELDS[role]!.feature} may come out empty`,
    );
  if (report.missingEnumValues.length)
    warnings.push(
      `schema enums lack ${report.missingEnumValues.join(", ")}: node types may be misread`,
    );

  const changes = message.nodeChanges;
  if (!Array.isArray(changes))
    warnings.push('message has no "nodeChanges" list: no nodes were read');
  else if (!changes.length) warnings.push('message "nodeChanges" is empty: no nodes were read');
  else {
    if (!doc.nodes.length)
      warnings.push(
        `0 of ${changes.length} stored nodes had a readable guid (sessionID/localID): the tree is empty`,
      );
    else if (doc.nodes.length < changes.length * 0.5)
      warnings.push(
        `only ${doc.nodes.length} of ${changes.length} stored nodes had a readable guid`,
      );
    if (doc.nodes.length && !doc.pages.length)
      warnings.push('no page (type "CANVAS") found: outline and pages[] are empty');
    if (doc.nodes.length > 1 && doc.roots.length > doc.nodes.length * 0.5)
      warnings.push(
        `${doc.roots.length} of ${doc.nodes.length} nodes have no parent: parentIndex may be misread`,
      );
    const texts = doc.nodes.filter((n) => n.type === "TEXT");
    if (texts.length && !texts.some((n) => typeof n.raw.textData?.characters === "string"))
      warnings.push(`${texts.length} text nodes but none carry textData.characters: text is empty`);
  }
  if (input.archiveMedia > 0 && input.referencedImages === 0)
    warnings.push(
      `the archive holds ${input.archiveMedia} media files but no paint referenced one: image paints (fillPaints[].image.hash) may be misread`,
    );

  const schemaMismatch = warnings.length > 0;
  return {
    schemaMismatch,
    warnings,
    ...(Object.keys(missing).length ? { missingFields: missing } : {}),
    ...(report.missingEnumValues.length ? { missingEnumValues: report.missingEnumValues } : {}),
    ...(schemaMismatch ? { hint: MISMATCH_HINT } : {}),
  };
}
