/**
 * COBOL source pre-processing and regex-based symbol extraction.
 *
 * DESIGN DECISION — Why regex instead of a full parser (ANTLR4, tree-sitter):
 *
 * 1. Performance: Regex processes ~1ms/file vs 50-200ms/file for ANTLR4/tree-sitter.
 *    On EPAGHE (14k COBOL files), this is ~14 seconds vs 12-47 minutes.
 *
 * 2. Reliability: tree-sitter-cobol@0.0.1's external scanner hangs indefinitely
 *    on ~5% of production files (no timeout possible). ANTLR4's proleap-cobol-parser
 *    is a Java project — using it from Node.js requires Java subprocesses or
 *    extracting .g4 grammars and generating JS/TS targets (significant effort).
 *
 * 3. Dialect compatibility: GnuCOBOL with Italian comments, patch markers in
 *    cols 1-6 (mzADD, estero, etc.), and vendor extensions. Formal grammars
 *    target COBOL-85 and would need dialect modifications.
 *
 * 4. Industry precedent: ctags, GitHub code navigation, and Sourcegraph all use
 *    regex-based extraction for code indexing. Full parsing is only needed for
 *    compilation or semantic analysis, not symbol extraction.
 *
 * 5. Determinism: Every regex pattern is tested with canonical COBOL input
 *    (see test/unit/cobol-preprocessor.test.ts). Same input always produces
 *    same output — no grammar ambiguity or parser state issues.
 *
 * This module provides:
 * 1. preprocessCobolSource() — cleans patch markers (kept for potential future use)
 * 2. extractCobolSymbolsWithRegex() — single-pass state machine COBOL extraction
 */

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface CobolRegexResults {
  programName: string | null;
  paragraphs: Array<{ name: string; line: number }>;
  sections: Array<{ name: string; line: number }>;
  performs: Array<{ caller: string | null; target: string; thruTarget?: string; line: number }>;
  calls: Array<{ target: string; line: number }>;
  copies: Array<{ target: string; line: number }>;
  dataItems: Array<{
    name: string;
    level: number;
    line: number;
    pic?: string;
    usage?: string;
    occurs?: number;
    redefines?: string;
    values?: string[];
    section: 'working-storage' | 'linkage' | 'file' | 'local-storage' | 'unknown';
  }>;
  fileDeclarations: Array<{
    selectName: string;
    assignTo: string;
    organization?: string;
    access?: string;
    recordKey?: string;
    fileStatus?: string;
    line: number;
  }>;
  fdEntries: Array<{
    fdName: string;
    recordName?: string;
    line: number;
  }>;
  programMetadata: {
    author?: string;
    dateWritten?: string;
  };

  // Phase 2: EXEC blocks
  execSqlBlocks: Array<{
    line: number;
    tables: string[];
    cursors: string[];
    hostVariables: string[];
    operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'DECLARE' | 'OPEN' | 'CLOSE' | 'FETCH' | 'OTHER';
  }>;
  execCicsBlocks: Array<{
    line: number;
    command: string;
    mapName?: string;
    programName?: string;
    transId?: string;
  }>;

  // Phase 3: Linkage + Data Flow
  procedureUsing: string[];
  entryPoints: Array<{
    name: string;
    parameters: string[];
    line: number;
  }>;
  moves: Array<{
    from: string;
    to: string;
    line: number;
    caller: string | null;
    corresponding: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Preserved exactly: preprocessCobolSource
// ---------------------------------------------------------------------------

/**
 * Clean COBOL source before tree-sitter parsing.
 * Replaces non-standard patch markers in columns 1-6 with spaces.
 * Preserves exact line count for AST position mapping.
 */
export function preprocessCobolSource(content: string): string {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < 7) continue;
    const seq = line.substring(0, 6);
    // Standard COBOL: cols 1-6 are spaces or digits (sequence numbers)
    // Patch markers contain letters or '#' — replace with spaces
    if (/[a-zA-Z#]/.test(seq)) {
      lines[i] = '      ' + line.substring(6);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Preserved exactly: EXCLUDED_PARA_NAMES
// ---------------------------------------------------------------------------

const EXCLUDED_PARA_NAMES = new Set([
  'DECLARATIVES', 'END', 'PROCEDURE', 'IDENTIFICATION',
  'ENVIRONMENT', 'DATA', 'WORKING-STORAGE', 'LINKAGE',
  'FILE', 'LOCAL-STORAGE', 'COMMUNICATION', 'REPORT',
  'SCREEN', 'INPUT-OUTPUT', 'CONFIGURATION',
]);

// ---------------------------------------------------------------------------
// State machine types
// ---------------------------------------------------------------------------

type Division = 'identification' | 'environment' | 'data' | 'procedure' | null;

type DataSection = 'working-storage' | 'linkage' | 'file' | 'local-storage' | 'unknown';

type EnvironmentSection = 'input-output' | 'configuration' | null;

// ---------------------------------------------------------------------------
// Regex constants (compiled once, reused across calls)
// ---------------------------------------------------------------------------

const RE_DIVISION = /\b(IDENTIFICATION|ENVIRONMENT|DATA|PROCEDURE)\s+DIVISION\b/i;
const RE_SECTION = /\b(WORKING-STORAGE|LINKAGE|FILE|LOCAL-STORAGE|INPUT-OUTPUT|CONFIGURATION)\s+SECTION\b/i;

// IDENTIFICATION DIVISION
const RE_PROGRAM_ID = /\bPROGRAM-ID\.\s*([A-Z][A-Z0-9-]*)/i;
const RE_AUTHOR = /^\s+AUTHOR\.\s*(.+)/i;
const RE_DATE_WRITTEN = /^\s+DATE-WRITTEN\.\s*(.+)/i;

// ENVIRONMENT DIVISION — SELECT
const RE_SELECT_START = /\bSELECT\s+([A-Z][A-Z0-9-]+)/i;

// DATA DIVISION
const RE_FD = /^\s+FD\s+([A-Z][A-Z0-9-]+)/i;
const RE_DATA_ITEM = /^\s+(\d{1,2})\s+([A-Z][A-Z0-9-]+)\s*(.*)/i;
const RE_ANONYMOUS_REDEFINES = /^\s+(\d{1,2})\s+REDEFINES\s+([A-Z][A-Z0-9-]+)/i;
const RE_88_LEVEL = /^\s+88\s+([A-Z][A-Z0-9-]+)\s+VALUES?\s+(?:ARE\s+)?(.+)/i;

// PROCEDURE DIVISION
const RE_PROC_SECTION = /^       ([A-Z][A-Z0-9-]+)\s+SECTION\.\s*$/;
const RE_PROC_PARAGRAPH = /^       ([A-Z][A-Z0-9-]+)\.\s*$/;
const RE_PERFORM = /\bPERFORM\s+([A-Z][A-Z0-9-]+)(?:\s+THRU\s+([A-Z][A-Z0-9-]+))?/i;

// ALL DIVISIONS
const RE_CALL = /\bCALL\s+"([^"]+)"/i;
const RE_COPY_UNQUOTED = /\bCOPY\s+([A-Z][A-Z0-9-]+)(?:\s|\.)/i;
const RE_COPY_QUOTED = /\bCOPY\s+"([^"]+)"(?:\s|\.)/i;

// EXEC blocks
const RE_EXEC_SQL_START = /\bEXEC\s+SQL\b/i;
const RE_EXEC_CICS_START = /\bEXEC\s+CICS\b/i;
const RE_END_EXEC = /\bEND-EXEC\b/i;

// PROCEDURE DIVISION USING
const RE_PROC_USING = /\bPROCEDURE\s+DIVISION\s+USING\s+([\s\S]*?)(?:\.|$)/i;

// ENTRY point
const RE_ENTRY = /\bENTRY\s+"([^"]+)"(?:\s+USING\s+([\s\S]*?))?(?:\.|$)/i;

// MOVE statement
const RE_MOVE = /\bMOVE\s+(CORRESPONDING\s+)?([A-Z][A-Z0-9-]+)\s+TO\s+([A-Z][A-Z0-9-]+)/i;
const MOVE_SKIP = new Set([
  'SPACES', 'ZEROS', 'ZEROES', 'LOW-VALUES', 'LOW-VALUE',
  'HIGH-VALUES', 'HIGH-VALUE', 'QUOTES', 'QUOTE', 'ALL',
]);

// ---------------------------------------------------------------------------
// Private helper: strip Italian inline comments (| and everything after)
// ---------------------------------------------------------------------------

function stripInlineComment(line: string): string {
  const idx = line.indexOf('|');
  return idx >= 0 ? line.substring(0, idx) : line;
}

// ---------------------------------------------------------------------------
// Private helper: parse data item trailing clauses (PIC, USAGE, etc.)
// ---------------------------------------------------------------------------

function parseDataItemClauses(rest: string): {
  pic?: string;
  usage?: string;
  redefines?: string;
  occurs?: number;
} {
  const result: { pic?: string; usage?: string; redefines?: string; occurs?: number } = {};

  // Strip trailing period for easier parsing
  const text = rest.replace(/\.\s*$/, '');

  // PIC / PICTURE [IS] <picture-string>
  const picMatch = text.match(/\bPIC(?:TURE)?\s+(?:IS\s+)?(\S+)/i);
  if (picMatch) {
    result.pic = picMatch[1];
  }

  // USAGE [IS] <usage-type> — including non-standard COMP-6, COMP-X etc.
  const usageMatch = text.match(/\bUSAGE\s+(?:IS\s+)?(COMP(?:UTATIONAL)?(?:-[0-9X])?|BINARY|PACKED-DECIMAL|DISPLAY|INDEX|POINTER|NATIONAL)\b/i);
  if (usageMatch) {
    result.usage = usageMatch[1].toUpperCase();
  } else {
    // Standalone COMP variants without USAGE keyword
    const compMatch = text.match(/\b(COMP(?:UTATIONAL)?(?:-[0-9X])?|BINARY|PACKED-DECIMAL)\b/i);
    if (compMatch) {
      result.usage = compMatch[1].toUpperCase();
    }
  }

  // REDEFINES <name>
  const redefMatch = text.match(/\bREDEFINES\s+([A-Z][A-Z0-9-]+)/i);
  if (redefMatch) {
    result.redefines = redefMatch[1];
  }

  // OCCURS <n> [TIMES]
  const occursMatch = text.match(/\bOCCURS\s+(\d+)/i);
  if (occursMatch) {
    result.occurs = parseInt(occursMatch[1], 10);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Private helper: parse 88-level condition values
// ---------------------------------------------------------------------------

function parseConditionValues(valuesStr: string): string[] {
  // Strip trailing period
  const text = valuesStr.replace(/\.\s*$/, '').trim();
  const values: string[] = [];

  // Match quoted strings: "O" "Y" "I"
  const quotedRe = /"([^"]*)"/g;
  let qm: RegExpExecArray | null;
  let hasQuoted = false;
  while ((qm = quotedRe.exec(text)) !== null) {
    values.push(qm[1]);
    hasQuoted = true;
  }
  if (hasQuoted) return values;

  // No quotes — split on whitespace, filtering out THRU/THROUGH keywords
  // Handle: 11 12 16 17 21   or   1 THRU 5
  const tokens = text.split(/\s+/);
  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (upper === 'THRU' || upper === 'THROUGH') {
      // Keep THRU ranges as combined value: prev THRU next is already captured
      // by having both sides in the array
      continue;
    }
    if (token.length > 0) {
      values.push(token);
    }
  }

  return values;
}

// ---------------------------------------------------------------------------
// Private helper: parse accumulated multi-line SELECT statement
// ---------------------------------------------------------------------------

interface FileDeclaration {
  selectName: string;
  assignTo: string;
  organization?: string;
  access?: string;
  recordKey?: string;
  fileStatus?: string;
  line: number;
}

function parseSelectStatement(stmt: string, startLine: number): FileDeclaration | null {
  // Normalize whitespace
  const text = stmt.replace(/\s+/g, ' ').trim();

  const nameMatch = text.match(/^SELECT\s+([A-Z][A-Z0-9-]+)/i);
  if (!nameMatch) return null;

  const result: FileDeclaration = {
    selectName: nameMatch[1],
    assignTo: '',
    line: startLine,
  };

  const assignMatch = text.match(/\bASSIGN\s+(?:TO\s+)?("([^"]+)"|([A-Z][A-Z0-9-]*))/i);
  if (assignMatch) {
    result.assignTo = assignMatch[2] || assignMatch[3] || '';
  }

  const orgMatch = text.match(/\bORGANIZATION\s+(?:IS\s+)?(SEQUENTIAL|INDEXED|RELATIVE|LINE\s+SEQUENTIAL)/i);
  if (orgMatch) {
    result.organization = orgMatch[1].toUpperCase();
  }

  const accessMatch = text.match(/\bACCESS\s+(?:MODE\s+)?(?:IS\s+)?(SEQUENTIAL|RANDOM|DYNAMIC)/i);
  if (accessMatch) {
    result.access = accessMatch[1].toUpperCase();
  }

  const keyMatch = text.match(/\bRECORD\s+KEY\s+(?:IS\s+)?([A-Z][A-Z0-9-]+)/i);
  if (keyMatch) {
    result.recordKey = keyMatch[1];
  }

  // FILE STATUS IS / STATUS IS
  const statusMatch = text.match(/\b(?:FILE\s+)?STATUS\s+(?:IS\s+)?([A-Z][A-Z0-9-]+)/i);
  if (statusMatch) {
    result.fileStatus = statusMatch[1];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Private helper: parse EXEC SQL block
// ---------------------------------------------------------------------------

type SqlOperation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'DECLARE' | 'OPEN' | 'CLOSE' | 'FETCH' | 'OTHER';

function parseExecSqlBlock(block: string, line: number): CobolRegexResults['execSqlBlocks'][number] {
  // Strip EXEC SQL ... END-EXEC wrapper
  const body = block
    .replace(/\bEXEC\s+SQL\b/i, '')
    .replace(/\bEND-EXEC\b/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Determine operation from first SQL keyword
  const firstWord = body.split(/\s+/)[0]?.toUpperCase() || '';
  const OP_MAP: Record<string, SqlOperation> = {
    SELECT: 'SELECT', INSERT: 'INSERT', UPDATE: 'UPDATE', DELETE: 'DELETE',
    DECLARE: 'DECLARE', OPEN: 'OPEN', CLOSE: 'CLOSE', FETCH: 'FETCH',
  };
  const operation: SqlOperation = OP_MAP[firstWord] || 'OTHER';

  // Extract table names from FROM, INTO (INSERT), UPDATE, DELETE FROM, JOIN
  const tables: string[] = [];
  const tablePatterns = [
    /\bFROM\s+([A-Z][A-Z0-9_]+)/gi,
    /\bINTO\s+([A-Z][A-Z0-9_]+)/gi,
    /\bUPDATE\s+([A-Z][A-Z0-9_]+)/gi,
    /\bJOIN\s+([A-Z][A-Z0-9_]+)/gi,
  ];
  for (const re of tablePatterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const name = m[1].toUpperCase();
      // Skip host variables and SQL keywords
      if (!name.startsWith(':') && !tables.includes(name)) {
        tables.push(name);
      }
    }
  }

  // Extract cursor names from DECLARE ... CURSOR
  const cursors: string[] = [];
  const cursorRe = /\bDECLARE\s+([A-Z][A-Z0-9_-]+)\s+CURSOR\b/gi;
  let cm: RegExpExecArray | null;
  while ((cm = cursorRe.exec(body)) !== null) {
    cursors.push(cm[1]);
  }

  // Extract host variables: :VARIABLE-NAME (strip the colon)
  const hostVariables: string[] = [];
  const hostRe = /:([A-Z][A-Z0-9-]+)/gi;
  let hm: RegExpExecArray | null;
  while ((hm = hostRe.exec(body)) !== null) {
    const name = hm[1];
    if (!hostVariables.includes(name)) {
      hostVariables.push(name);
    }
  }

  return { line, tables, cursors, hostVariables, operation };
}

// ---------------------------------------------------------------------------
// Private helper: parse EXEC CICS block
// ---------------------------------------------------------------------------

function parseExecCicsBlock(block: string, line: number): CobolRegexResults['execCicsBlocks'][number] {
  // Strip EXEC CICS ... END-EXEC wrapper
  const body = block
    .replace(/\bEXEC\s+CICS\b/i, '')
    .replace(/\bEND-EXEC\b/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Command: first keyword(s) — handle two-word commands like SEND MAP, RECEIVE MAP
  const twoWordCommands = ['SEND MAP', 'RECEIVE MAP', 'SEND TEXT', 'SEND CONTROL', 'READ NEXT', 'READ PREV'];
  let command = '';
  const upperBody = body.toUpperCase();
  for (const twoWord of twoWordCommands) {
    if (upperBody.startsWith(twoWord)) {
      command = twoWord;
      break;
    }
  }
  if (!command) {
    command = body.split(/\s+/)[0]?.toUpperCase() || '';
  }

  const result: CobolRegexResults['execCicsBlocks'][number] = { line, command };

  // MAP name: MAP('name') or MAP("name")
  const mapMatch = body.match(/\bMAP\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
  if (mapMatch) result.mapName = mapMatch[1];

  // PROGRAM name: PROGRAM('name') or PROGRAM("name")
  const progMatch = body.match(/\bPROGRAM\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
  if (progMatch) result.programName = progMatch[1];

  // TRANSID: TRANSID('name') or TRANSID("name")
  const transMatch = body.match(/\bTRANSID\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
  if (transMatch) result.transId = transMatch[1];

  return result;
}

// ---------------------------------------------------------------------------
// Main extraction: single-pass state machine
// ---------------------------------------------------------------------------

/**
 * Extract COBOL symbols using a single-pass state machine.
 * Extracts program name, paragraphs, sections, CALL, PERFORM, COPY,
 * data items, file declarations, FD entries, and program metadata.
 */
export function extractCobolSymbolsWithRegex(
  content: string,
  _filePath: string,
): CobolRegexResults {
  const rawLines = content.split('\n');

  const result: CobolRegexResults = {
    programName: null,
    paragraphs: [],
    sections: [],
    performs: [],
    calls: [],
    copies: [],
    dataItems: [],
    fileDeclarations: [],
    fdEntries: [],
    programMetadata: {},
    execSqlBlocks: [],
    execCicsBlocks: [],
    procedureUsing: [],
    entryPoints: [],
    moves: [],
  };

  // --- State ---
  let currentDivision: Division = null;
  let currentDataSection: DataSection = 'unknown';
  let currentEnvSection: EnvironmentSection = null;
  let currentParagraph: string | null = null;

  // SELECT accumulator (multi-line)
  let selectAccum: string | null = null;
  let selectStartLine = 0;

  // EXEC block accumulator (multi-line EXEC SQL / EXEC CICS)
  let execAccum: { type: 'sql' | 'cics'; lines: string; startLine: number } | null = null;

  // FD tracking: after seeing FD, the next 01-level data item is its record
  let pendingFdName: string | null = null;
  let pendingFdLine = 0;

  // Continuation line buffer
  let pendingLine: string | null = null;
  let pendingLineNumber = 0;

  // --- Process each raw line ---
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];

    // Skip lines too short to have indicator area
    if (raw.length < 7) {
      // If there's a pending continuation, flush it
      if (pendingLine !== null) {
        processLogicalLine(pendingLine, pendingLineNumber);
        pendingLine = null;
      }
      continue;
    }

    const indicator = raw[6];

    // Comment line: indicator is '*' or '/'
    if (indicator === '*' || indicator === '/') {
      continue;
    }

    // Continuation line: indicator is '-'
    if (indicator === '-') {
      if (pendingLine !== null) {
        // Append continuation (area B content, trimmed leading spaces)
        const continuation = raw.substring(7).trimStart();
        pendingLine += continuation;
      }
      continue;
    }

    // Normal line — flush any pending continuation first
    if (pendingLine !== null) {
      processLogicalLine(pendingLine, pendingLineNumber);
      pendingLine = null;
    }

    // Strip inline Italian comments, then use area A+B (from col 7 onwards,
    // but keep full line for indentation-sensitive paragraph/section detection)
    const cleaned = stripInlineComment(raw);

    // Buffer as new pending logical line
    pendingLine = cleaned;
    pendingLineNumber = i;
  }

  // Flush final pending line
  if (pendingLine !== null) {
    processLogicalLine(pendingLine, pendingLineNumber);
  }

  // Flush any pending SELECT
  flushSelect();

  // If we saw an FD but never found its record, emit it without a record name
  if (pendingFdName !== null) {
    result.fdEntries.push({ fdName: pendingFdName, line: pendingFdLine });
    pendingFdName = null;
  }

  return result;

  // =========================================================================
  // Inner function: process one logical line (after continuation merging)
  // =========================================================================
  function processLogicalLine(line: string, lineNum: number): void {
    // --- EXEC block accumulation (spans any division) ---
    if (execAccum !== null) {
      execAccum.lines += ' ' + line;
      if (RE_END_EXEC.test(line)) {
        if (execAccum.type === 'sql') {
          result.execSqlBlocks.push(parseExecSqlBlock(execAccum.lines, execAccum.startLine));
        } else {
          result.execCicsBlocks.push(parseExecCicsBlock(execAccum.lines, execAccum.startLine));
        }
        execAccum = null;
      }
      return; // While accumulating, skip normal processing
    }

    // Check for EXEC SQL / EXEC CICS start
    if (RE_EXEC_SQL_START.test(line)) {
      execAccum = { type: 'sql', lines: line, startLine: lineNum };
      // If END-EXEC is on the same line, finalize immediately
      if (RE_END_EXEC.test(line)) {
        result.execSqlBlocks.push(parseExecSqlBlock(execAccum.lines, execAccum.startLine));
        execAccum = null;
      }
      return;
    }
    if (RE_EXEC_CICS_START.test(line)) {
      execAccum = { type: 'cics', lines: line, startLine: lineNum };
      if (RE_END_EXEC.test(line)) {
        result.execCicsBlocks.push(parseExecCicsBlock(execAccum.lines, execAccum.startLine));
        execAccum = null;
      }
      return;
    }

    // --- Division transitions ---
    const divMatch = line.match(RE_DIVISION);
    if (divMatch) {
      // Flush SELECT if transitioning out of environment
      flushSelect();

      const divName = divMatch[1].toUpperCase();
      switch (divName) {
        case 'IDENTIFICATION': currentDivision = 'identification'; break;
        case 'ENVIRONMENT':    currentDivision = 'environment'; currentEnvSection = null; break;
        case 'DATA':           currentDivision = 'data'; currentDataSection = 'unknown'; break;
        case 'PROCEDURE': {
          currentDivision = 'procedure';
          currentParagraph = null;
          const procUsingMatch = line.match(RE_PROC_USING);
          if (procUsingMatch) {
            result.procedureUsing = procUsingMatch[1].trim().split(/\s+/).filter(s => s.length > 0);
          }
          break;
        }
      }
      return;
    }

    // --- Section transitions ---
    const secMatch = line.match(RE_SECTION);
    if (secMatch) {
      flushSelect();

      const secName = secMatch[1].toUpperCase();
      switch (secName) {
        case 'WORKING-STORAGE': currentDivision = 'data'; currentDataSection = 'working-storage'; break;
        case 'LINKAGE':         currentDivision = 'data'; currentDataSection = 'linkage'; break;
        case 'FILE':            currentDivision = 'data'; currentDataSection = 'file'; break;
        case 'LOCAL-STORAGE':   currentDivision = 'data'; currentDataSection = 'local-storage'; break;
        case 'INPUT-OUTPUT':    currentDivision = 'environment'; currentEnvSection = 'input-output'; break;
        case 'CONFIGURATION':   currentDivision = 'environment'; currentEnvSection = 'configuration'; break;
      }
      return;
    }

    // --- COPY (all divisions) ---
    const copyQMatch = line.match(RE_COPY_QUOTED);
    if (copyQMatch) {
      result.copies.push({ target: copyQMatch[1], line: lineNum });
    } else {
      const copyUMatch = line.match(RE_COPY_UNQUOTED);
      if (copyUMatch) {
        result.copies.push({ target: copyUMatch[1], line: lineNum });
      }
    }

    // --- CALL (all divisions, typically procedure) ---
    const callMatch = line.match(RE_CALL);
    if (callMatch) {
      result.calls.push({ target: callMatch[1], line: lineNum });
    }

    // --- Division-specific extraction ---
    switch (currentDivision) {
      case 'identification':
        extractIdentification(line, lineNum);
        break;
      case 'environment':
        extractEnvironment(line, lineNum);
        break;
      case 'data':
        extractData(line, lineNum);
        break;
      case 'procedure':
        extractProcedure(line, lineNum);
        break;
    }
  }

  // =========================================================================
  // IDENTIFICATION DIVISION extraction
  // =========================================================================
  function extractIdentification(line: string, _lineNum: number): void {
    if (result.programName === null) {
      const m = line.match(RE_PROGRAM_ID);
      if (m) {
        result.programName = m[1];
        return;
      }
    }

    const authorMatch = line.match(RE_AUTHOR);
    if (authorMatch) {
      result.programMetadata.author = authorMatch[1].replace(/\.\s*$/, '').trim();
      return;
    }

    const dateMatch = line.match(RE_DATE_WRITTEN);
    if (dateMatch) {
      result.programMetadata.dateWritten = dateMatch[1].replace(/\.\s*$/, '').trim();
    }
  }

  // =========================================================================
  // ENVIRONMENT DIVISION extraction
  // =========================================================================
  function extractEnvironment(line: string, lineNum: number): void {
    if (currentEnvSection !== 'input-output') return;

    // Check for new SELECT statement
    const selMatch = line.match(RE_SELECT_START);
    if (selMatch) {
      // Flush any previous SELECT
      flushSelect();
      selectAccum = line.trim();
      selectStartLine = lineNum;
    } else if (selectAccum !== null) {
      // Accumulate continuation of current SELECT
      selectAccum += ' ' + line.trim();
    }

    // Check if current SELECT is terminated (ends with period)
    if (selectAccum !== null && /\.\s*$/.test(selectAccum)) {
      flushSelect();
    }
  }

  function flushSelect(): void {
    if (selectAccum === null) return;
    const decl = parseSelectStatement(selectAccum, selectStartLine);
    if (decl) {
      result.fileDeclarations.push(decl);
    }
    selectAccum = null;
  }

  // =========================================================================
  // DATA DIVISION extraction
  // =========================================================================
  function extractData(line: string, lineNum: number): void {
    // FD entry
    const fdMatch = line.match(RE_FD);
    if (fdMatch) {
      // Flush any previous FD without a record
      if (pendingFdName !== null) {
        result.fdEntries.push({ fdName: pendingFdName, line: pendingFdLine });
      }
      pendingFdName = fdMatch[1];
      pendingFdLine = lineNum;
      return;
    }

    // 88-level condition names
    const lv88Match = line.match(RE_88_LEVEL);
    if (lv88Match) {
      const name = lv88Match[1];
      const values = parseConditionValues(lv88Match[2]);
      result.dataItems.push({
        name,
        level: 88,
        line: lineNum,
        values,
        section: currentDataSection,
      });
      return;
    }

    // Anonymous REDEFINES (no name, e.g. "01 REDEFINES WK-PERIVAL.")
    const anonRedefMatch = line.match(RE_ANONYMOUS_REDEFINES);
    if (anonRedefMatch) {
      // Check it's truly anonymous: the second capture is not a valid data name
      // followed by more clauses — it's the REDEFINES target directly after level
      const level = parseInt(anonRedefMatch[1], 10);
      // Only skip if this is genuinely "NN REDEFINES target" with no name between
      // We detect this by checking the full data item regex does NOT match
      // (because RE_DATA_ITEM expects a name before any clauses)
      const dataMatch = line.match(RE_DATA_ITEM);
      if (!dataMatch || dataMatch[2].toUpperCase() === 'REDEFINES') {
        // Truly anonymous — skip, no node
        return;
      }
    }

    // Standard data items: level 01-49, 66, 77
    const dataMatch = line.match(RE_DATA_ITEM);
    if (dataMatch) {
      const level = parseInt(dataMatch[1], 10);
      const name = dataMatch[2];
      const rest = dataMatch[3] || '';

      // Skip FILLER
      if (name.toUpperCase() === 'FILLER') return;

      // Valid levels: 01-49, 66, 77
      if ((level >= 1 && level <= 49) || level === 66 || level === 77) {
        const clauses = parseDataItemClauses(rest);

        const item: CobolRegexResults['dataItems'][number] = {
          name,
          level,
          line: lineNum,
          section: currentDataSection,
        };
        if (clauses.pic) item.pic = clauses.pic;
        if (clauses.usage) item.usage = clauses.usage;
        if (clauses.occurs !== undefined) item.occurs = clauses.occurs;
        if (clauses.redefines) item.redefines = clauses.redefines;

        result.dataItems.push(item);

        // If there's a pending FD and this is a 01-level, it's the FD's record
        if (pendingFdName !== null && level === 1) {
          result.fdEntries.push({
            fdName: pendingFdName,
            recordName: name,
            line: pendingFdLine,
          });
          pendingFdName = null;
        }
      }
    }
  }

  // =========================================================================
  // PROCEDURE DIVISION extraction
  // =========================================================================
  function extractProcedure(line: string, lineNum: number): void {
    // Section header
    const secMatch = line.match(RE_PROC_SECTION);
    if (secMatch) {
      const name = secMatch[1];
      if (!EXCLUDED_PARA_NAMES.has(name) && !name.includes('DIVISION')) {
        result.sections.push({ name, line: lineNum });
        currentParagraph = name;
      }
      return;
    }

    // Paragraph header
    const paraMatch = line.match(RE_PROC_PARAGRAPH);
    if (paraMatch) {
      const name = paraMatch[1];
      if (!EXCLUDED_PARA_NAMES.has(name) && !name.includes('DIVISION') && !name.includes('SECTION')) {
        result.paragraphs.push({ name, line: lineNum });
        currentParagraph = name;
      }
      return;
    }

    // PERFORM
    const perfMatch = line.match(RE_PERFORM);
    if (perfMatch) {
      result.performs.push({
        caller: currentParagraph,
        target: perfMatch[1],
        thruTarget: perfMatch[2] || undefined,
        line: lineNum,
      });
    }

    // ENTRY point
    const entryMatch = line.match(RE_ENTRY);
    if (entryMatch) {
      result.entryPoints.push({
        name: entryMatch[1],
        parameters: entryMatch[2] ? entryMatch[2].trim().split(/\s+/).filter(s => s.length > 0) : [],
        line: lineNum,
      });
    }

    // MOVE statement (skip literals and figurative constants)
    const moveMatch = line.match(RE_MOVE);
    if (moveMatch) {
      const from = moveMatch[2].toUpperCase();
      if (!MOVE_SKIP.has(from)) {
        result.moves.push({
          from: moveMatch[2],
          to: moveMatch[3],
          line: lineNum,
          caller: currentParagraph,
          corresponding: !!moveMatch[1],
        });
      }
    }
  }
}
