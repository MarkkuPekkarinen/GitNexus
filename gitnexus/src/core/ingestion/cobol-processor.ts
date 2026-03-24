/**
 * COBOL Processor
 *
 * Standalone regex-based processor for COBOL and JCL files.
 * Follows the markdown-processor.ts pattern: takes (graph, files, allPathSet),
 * does its own extraction, and writes directly to the graph.
 *
 * Pipeline:
 *   1. Separate programs from copybooks
 *   2. Build copybook map (name -> content)
 *   3. For each program: expand COPY statements, then run regex extraction
 *   4. Map CobolRegexResults to graph nodes and relationships
 *   5. Optionally process JCL files for job-step cross-references
 */

import path from 'node:path';
import { generateId } from '../../lib/utils.js';
import type { KnowledgeGraph, GraphNode } from '../graph/types.js';
import {
  preprocessCobolSource,
  extractCobolSymbolsWithRegex,
  type CobolRegexResults,
} from './cobol/cobol-preprocessor.js';
import { expandCopies } from './cobol/cobol-copy-expander.js';
import { processJclFiles } from './cobol/jcl-processor.js';

// ---------------------------------------------------------------------------
// File detection
// ---------------------------------------------------------------------------

const COBOL_EXTENSIONS = new Set([
  '.cob', '.cbl', '.cobol', '.cpy', '.copybook',
]);

const JCL_EXTENSIONS = new Set(['.jcl', '.job', '.proc']);

const COPYBOOK_EXTENSIONS = new Set(['.cpy', '.copybook']);

interface CobolFile {
  path: string;
  content: string;
}

export interface CobolProcessResult {
  programs: number;
  paragraphs: number;
  sections: number;
  dataItems: number;
  calls: number;
  copies: number;
  jclJobs: number;
  jclSteps: number;
}

/** Returns true if the file is a COBOL or copybook file. */
export function isCobolFile(filePath: string): boolean {
  return COBOL_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Returns true if the file is a JCL file. */
export function isJclFile(filePath: string): boolean {
  return JCL_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Returns true if the file is a COBOL copybook. */
function isCopybook(filePath: string): boolean {
  return COPYBOOK_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

/**
 * Process COBOL and JCL files into the knowledge graph.
 *
 * @param graph    - The in-memory knowledge graph
 * @param files    - Array of { path, content } for COBOL/JCL files
 * @param allPathSet - Set of all file paths in the repository
 * @returns Summary of what was extracted
 */
export const processCobol = (
  graph: KnowledgeGraph,
  files: CobolFile[],
  allPathSet: Set<string>,
): CobolProcessResult => {
  const result: CobolProcessResult = {
    programs: 0,
    paragraphs: 0,
    sections: 0,
    dataItems: 0,
    calls: 0,
    copies: 0,
    jclJobs: 0,
    jclSteps: 0,
  };

  // ── 1. Separate programs, copybooks, and JCL ───────────────────────
  const programs: CobolFile[] = [];
  const copybooks: CobolFile[] = [];
  const jclFiles: CobolFile[] = [];

  for (const file of files) {
    const ext = path.extname(file.path).toLowerCase();
    if (JCL_EXTENSIONS.has(ext)) {
      jclFiles.push(file);
    } else if (isCopybook(file.path)) {
      copybooks.push(file);
    } else if (COBOL_EXTENSIONS.has(ext)) {
      programs.push(file);
    }
  }

  // ── 2. Build copybook map (uppercase name -> content) ──────────────
  const copybookMap = new Map<string, { content: string; path: string }>();
  for (const cb of copybooks) {
    const name = path.basename(cb.path, path.extname(cb.path)).toUpperCase();
    copybookMap.set(name, { content: cb.content, path: cb.path });
  }

  // Resolve and read callbacks for expandCopies
  const resolveCopy = (name: string): string | null => {
    const entry = copybookMap.get(name.toUpperCase());
    return entry ? entry.path : null;
  };
  const readCopy = (copyPath: string): string | null => {
    // Find by path match
    for (const [, entry] of copybookMap) {
      if (entry.path === copyPath) return entry.content;
    }
    return null;
  };

  // Track module names for cross-program CALL resolution
  const moduleNodeIds = new Map<string, string>(); // uppercase program name -> node id

  // ── 3. Process each COBOL program ──────────────────────────────────
  for (const file of programs) {
    const fileNodeId = generateId('File', file.path);
    // Skip if file node doesn't exist (structure-processor creates it)
    if (!graph.getNode(fileNodeId)) continue;

    // Preprocess: clean patch markers
    const cleaned = preprocessCobolSource(file.content);

    // Expand COPY statements
    const { expandedContent, copyResolutions } = expandCopies(
      cleaned, file.path, resolveCopy, readCopy,
    );

    // Extract symbols from expanded source
    const extracted = extractCobolSymbolsWithRegex(expandedContent, file.path);

    // Map to graph
    mapToGraph(graph, extracted, file, copyResolutions, moduleNodeIds);

    // Accumulate stats
    result.programs += extracted.programName ? 1 : 0;
    result.paragraphs += extracted.paragraphs.length;
    result.sections += extracted.sections.length;
    result.dataItems += extracted.dataItems.length;
    result.calls += extracted.calls.length;
    result.copies += extracted.copies.length;
  }

  // ── 4. Second pass: resolve cross-program CALL targets ─────────────
  // Now that all modules are registered, create CALLS edges for
  // unresolved CALL targets that match a known module name.
  // (Already handled inline during mapToGraph via moduleNodeIds)

  // ── 5. Process JCL files ───────────────────────────────────────────
  if (jclFiles.length > 0) {
    const jclPaths = jclFiles.map(f => f.path);
    const jclContents = new Map<string, string>();
    for (const f of jclFiles) {
      jclContents.set(f.path, f.content);
    }
    const jclResult = processJclFiles(graph, jclPaths, jclContents);
    result.jclJobs += jclResult.jobCount;
    result.jclSteps += jclResult.stepCount;
  }

  return result;
};

// ---------------------------------------------------------------------------
// Graph mapping
// ---------------------------------------------------------------------------

function mapToGraph(
  graph: KnowledgeGraph,
  extracted: CobolRegexResults,
  file: CobolFile,
  copyResolutions: Array<{ copyTarget: string; resolvedPath: string | null; line: number }>,
  moduleNodeIds: Map<string, string>,
): void {
  const { path: filePath, content } = file;
  const lines = content.split('\n');
  const fileNodeId = generateId('File', filePath);

  // ── PROGRAM-ID -> Module node ────────────────────────────────────
  let moduleId: string | undefined;
  if (extracted.programName) {
    moduleId = generateId('Module', `${filePath}:${extracted.programName}`);
    graph.addNode({
      id: moduleId,
      label: 'Module',
      properties: {
        name: extracted.programName,
        filePath,
        startLine: 1,
        endLine: lines.length,
        language: 'cobol' as any,
        isExported: true,
      },
    });
    graph.addRelationship({
      id: generateId('CONTAINS', `${fileNodeId}->${moduleId}`),
      type: 'CONTAINS',
      sourceId: fileNodeId,
      targetId: moduleId,
      confidence: 1.0,
      reason: 'cobol-program-id',
    });
    moduleNodeIds.set(extracted.programName.toUpperCase(), moduleId);
  }

  const parentId = moduleId ?? fileNodeId;

  // ── SECTIONs -> Namespace nodes ──────────────────────────────────
  const sectionNodeIds = new Map<string, string>();
  for (let i = 0; i < extracted.sections.length; i++) {
    const sec = extracted.sections[i];
    const nextLine = i + 1 < extracted.sections.length
      ? extracted.sections[i + 1].line - 1
      : lines.length;
    const secId = generateId('Namespace', `${filePath}:${sec.name}`);
    graph.addNode({
      id: secId,
      label: 'Namespace',
      properties: {
        name: sec.name,
        filePath,
        startLine: sec.line,
        endLine: nextLine,
        language: 'cobol' as any,
        isExported: true,
      },
    });
    graph.addRelationship({
      id: generateId('CONTAINS', `${parentId}->${secId}`),
      type: 'CONTAINS',
      sourceId: parentId,
      targetId: secId,
      confidence: 1.0,
      reason: 'cobol-section',
    });
    sectionNodeIds.set(sec.name.toUpperCase(), secId);
  }

  // ── PARAGRAPHs -> Function nodes ─────────────────────────────────
  const paraNodeIds = new Map<string, string>();
  for (let i = 0; i < extracted.paragraphs.length; i++) {
    const para = extracted.paragraphs[i];
    const nextLine = i + 1 < extracted.paragraphs.length
      ? extracted.paragraphs[i + 1].line - 1
      : lines.length;
    const paraId = generateId('Function', `${filePath}:${para.name}`);
    graph.addNode({
      id: paraId,
      label: 'Function',
      properties: {
        name: para.name,
        filePath,
        startLine: para.line,
        endLine: nextLine,
        language: 'cobol' as any,
        isExported: true,
      },
    });
    // Parent: find the containing section, or fall back to module/file
    const containerId = findContainingSection(para.line, extracted.sections, sectionNodeIds) ?? parentId;
    graph.addRelationship({
      id: generateId('CONTAINS', `${containerId}->${paraId}`),
      type: 'CONTAINS',
      sourceId: containerId,
      targetId: paraId,
      confidence: 1.0,
      reason: 'cobol-paragraph',
    });
    paraNodeIds.set(para.name.toUpperCase(), paraId);
  }

  // ── Data items -> Property nodes ─────────────────────────────────
  for (const item of extracted.dataItems) {
    if (item.name === 'FILLER') continue; // Skip anonymous fillers
    const propId = generateId('Property', `${filePath}:${item.name}`);
    graph.addNode({
      id: propId,
      label: 'Property',
      properties: {
        name: item.name,
        filePath,
        startLine: item.line,
        endLine: item.line,
        language: 'cobol' as any,
        description: `level:${item.level} section:${item.section}${item.pic ? ` pic:${item.pic}` : ''}`,
      },
    });
    graph.addRelationship({
      id: generateId('CONTAINS', `${parentId}->${propId}`),
      type: 'CONTAINS',
      sourceId: parentId,
      targetId: propId,
      confidence: 1.0,
      reason: 'cobol-data-item',
    });
  }

  // ── PERFORM -> CALLS relationship (intra-file) ──────────────────
  for (const perf of extracted.performs) {
    const targetId = paraNodeIds.get(perf.target.toUpperCase())
      ?? sectionNodeIds.get(perf.target.toUpperCase());
    if (!targetId) continue;

    // Source: the paragraph containing the PERFORM, or the module
    const sourceId = perf.caller
      ? (paraNodeIds.get(perf.caller.toUpperCase()) ?? parentId)
      : parentId;

    graph.addRelationship({
      id: generateId('CALLS', `${sourceId}->perform->${targetId}:L${perf.line}`),
      type: 'CALLS',
      sourceId,
      targetId,
      confidence: 1.0,
      reason: 'cobol-perform',
    });
  }

  // ── CALL -> CALLS relationship (cross-program) ──────────────────
  for (const call of extracted.calls) {
    const targetModuleId = moduleNodeIds.get(call.target.toUpperCase());
    // Create edge even if target not yet known — use a synthetic target id
    const targetId = targetModuleId
      ?? generateId('Module', `<unresolved>:${call.target.toUpperCase()}`);

    graph.addRelationship({
      id: generateId('CALLS', `${parentId}->call->${call.target}:L${call.line}`),
      type: 'CALLS',
      sourceId: parentId,
      targetId,
      confidence: targetModuleId ? 0.95 : 0.5,
      reason: targetModuleId ? 'cobol-call' : 'cobol-call-unresolved',
    });
  }

  // ── COPY -> IMPORTS relationship ─────────────────────────────────
  for (const res of copyResolutions) {
    if (!res.resolvedPath) continue;
    const targetFileId = generateId('File', res.resolvedPath);
    graph.addRelationship({
      id: generateId('IMPORTS', `${fileNodeId}->${targetFileId}:${res.copyTarget}`),
      type: 'IMPORTS',
      sourceId: fileNodeId,
      targetId: targetFileId,
      confidence: 1.0,
      reason: 'cobol-copy',
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the section that contains a given line number. */
function findContainingSection(
  line: number,
  sections: Array<{ name: string; line: number }>,
  sectionNodeIds: Map<string, string>,
): string | undefined {
  // Sections are in order; find the last section whose start line <= the target line
  let best: string | undefined;
  for (const sec of sections) {
    if (sec.line <= line) {
      best = sectionNodeIds.get(sec.name.toUpperCase());
    } else {
      break;
    }
  }
  return best;
}
