import { describe, it, expect } from 'vitest';
import {
  preprocessCobolSource,
  extractCobolSymbolsWithRegex,
} from '../../src/core/ingestion/cobol/cobol-preprocessor.js';
import type { CobolRegexResults } from '../../src/core/ingestion/cobol/cobol-preprocessor.js';

// ---------------------------------------------------------------------------
// Helper: build COBOL source from an array of lines.
//
// The parser processes full raw lines including columns 1-6 (sequence area).
// Regexes anchored with ^\s+ (data items, FD, AUTHOR, etc.) require the line
// to start with whitespace, so test lines use spaces in cols 1-6 instead of
// numeric sequence numbers unless specifically testing sequence-number behavior.
//
// Column layout:
//   1-6:  sequence/patch area (spaces or digits)
//   7:    indicator (* comment, - continuation, / page break, space normal)
//   8-11: Area A (divisions, sections, paragraphs start here = 7 leading spaces)
//   12+:  Area B (statements = 11+ leading spaces)
// ---------------------------------------------------------------------------
function cobol(...lines: string[]): string {
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// preprocessCobolSource
// ---------------------------------------------------------------------------

describe('preprocessCobolSource', () => {
  it('replaces alphabetic patch markers in cols 1-6 with spaces', () => {
    const input = cobol(
      'mzADD  IDENTIFICATION DIVISION.',
      'estero PROGRAM-ID. TEST1.',
    );
    const output = preprocessCobolSource(input);
    const lines = output.split('\n');
    expect(lines[0].substring(0, 6)).toBe('      ');
    expect(lines[0].substring(6)).toBe(' IDENTIFICATION DIVISION.');
    expect(lines[1].substring(0, 6)).toBe('      ');
  });

  it('strips numeric sequence numbers from cols 1-6', () => {
    const input = cobol(
      '000100 IDENTIFICATION DIVISION.',
      '000200 PROGRAM-ID. TEST1.',
    );
    const output = preprocessCobolSource(input);
    const lines = output.split('\n');
    expect(lines[0]).toBe('       IDENTIFICATION DIVISION.');
    expect(lines[1]).toBe('       PROGRAM-ID. TEST1.');
  });

  it('preserves lines shorter than 7 characters', () => {
    const input = cobol('SHORT', '      ', '000100 IDENTIFICATION DIVISION.');
    const output = preprocessCobolSource(input);
    const lines = output.split('\n');
    expect(lines[0]).toBe('SHORT');
    expect(lines[1]).toBe('      ');
  });

  it('preserves exact line count (no lines added/removed)', () => {
    const input = cobol(
      'mzADD  IDENTIFICATION DIVISION.',
      '000200 PROGRAM-ID. TEST1.',
      'patch# DATA DIVISION.',
      '',
      '000500 PROCEDURE DIVISION.',
    );
    const output = preprocessCobolSource(input);
    expect(output.split('\n').length).toBe(input.split('\n').length);
  });
});

// ---------------------------------------------------------------------------
// extractCobolSymbolsWithRegex
// ---------------------------------------------------------------------------

describe('extractCobolSymbolsWithRegex', () => {

  // -------------------------------------------------------------------------
  // PROGRAM-ID
  // -------------------------------------------------------------------------
  describe('PROGRAM-ID', () => {
    it('extracts PROGRAM-ID from IDENTIFICATION DIVISION', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.programName).toBe('TESTPROG');
    });

    it('returns null programName for content without PROGRAM-ID', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       AUTHOR. SOMEONE.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.programName).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Paragraphs & Sections
  // -------------------------------------------------------------------------
  describe('Paragraphs & Sections', () => {
    it('extracts paragraphs in PROCEDURE DIVISION (7 leading spaces)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           DISPLAY "HELLO".',
        '       SUB-PARA.',
        '           DISPLAY "WORLD".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.paragraphs).toHaveLength(2);
      expect(r.paragraphs[0].name).toBe('MAIN-PARA');
      expect(r.paragraphs[1].name).toBe('SUB-PARA');
    });

    it('extracts sections in PROCEDURE DIVISION', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       INIT-SECTION SECTION.',
        '       INIT-PARA.',
        '           DISPLAY "INIT".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.sections).toHaveLength(1);
      expect(r.sections[0].name).toBe('INIT-SECTION');
      expect(r.paragraphs).toHaveLength(1);
      expect(r.paragraphs[0].name).toBe('INIT-PARA');
    });

    it('excludes reserved names (DECLARATIVES, END, PROCEDURE, etc.)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       DECLARATIVES.',
        '       END.',
        '       REAL-PARA.',
        '           DISPLAY "OK".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.paragraphs.map(p => p.name)).toEqual(['REAL-PARA']);
    });

    it('does NOT treat IDENTIFICATION/ENVIRONMENT/DATA/WORKING-STORAGE as paragraphs', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      ENVIRONMENT DIVISION.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '      PROCEDURE DIVISION.',
        '       REAL-PARA.',
        '           DISPLAY "OK".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      const names = r.paragraphs.map(p => p.name);
      expect(names).not.toContain('IDENTIFICATION');
      expect(names).not.toContain('ENVIRONMENT');
      expect(names).not.toContain('DATA');
      expect(names).not.toContain('WORKING-STORAGE');
      expect(names).toContain('REAL-PARA');
    });
  });

  // -------------------------------------------------------------------------
  // CALL / PERFORM / COPY
  // -------------------------------------------------------------------------
  describe('CALL / PERFORM / COPY', () => {
    it('extracts CALL "PROGRAM" statements', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           CALL "SUBPROG".',
        '           CALL "ANOTHER".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(2);
      expect(r.calls[0].target).toBe('SUBPROG');
      expect(r.calls[1].target).toBe('ANOTHER');
    });

    it("extracts CALL 'PROGRAM' statements (single-quoted target)", () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'SUBPROG'.",
        "           CALL 'ANOTHER'.",
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(2);
      expect(r.calls[0].target).toBe('SUBPROG');
      expect(r.calls[1].target).toBe('ANOTHER');
    });

    it('extracts PERFORM paragraph-name with caller context', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           PERFORM SUB-PARA.',
        '       SUB-PARA.',
        '           DISPLAY "HELLO".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.performs).toHaveLength(1);
      expect(r.performs[0].target).toBe('SUB-PARA');
      expect(r.performs[0].caller).toBe('MAIN-PARA');
    });

    it('extracts PERFORM ... THRU ... statements', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           PERFORM STEP-A THRU STEP-Z.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.performs).toHaveLength(1);
      expect(r.performs[0].target).toBe('STEP-A');
      expect(r.performs[0].thruTarget).toBe('STEP-Z');
    });

    it('extracts COPY copybook (unquoted)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '           COPY WSCOPY.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.copies).toHaveLength(1);
      expect(r.copies[0].target).toBe('WSCOPY');
    });

    it('extracts COPY "copybook" (quoted)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '           COPY "MY-COPY".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.copies).toHaveLength(1);
      expect(r.copies[0].target).toBe('MY-COPY');
    });

    it("extracts COPY 'copybook' (single-quoted)", () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        "           COPY 'MY-COPY'.",
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.copies).toHaveLength(1);
      expect(r.copies[0].target).toBe('MY-COPY');
    });

    it('does NOT store PERFORM UNTIL as a perform target', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           PERFORM UNTIL WS-EOF = 1.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.performs.map(p => p.target)).not.toContain('UNTIL');
    });

    it('does NOT store PERFORM VARYING as a perform target', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           PERFORM VARYING I FROM 1 BY 1 UNTIL I > 10.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.performs.map(p => p.target)).not.toContain('VARYING');
    });

    it('does NOT store PERFORM WITH TEST as a perform target', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           PERFORM WITH TEST AFTER UNTIL WS-DONE.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.performs.map(p => p.target)).not.toContain('WITH');
    });
  });

  // -------------------------------------------------------------------------
  // Data Division
  // -------------------------------------------------------------------------
  describe('Data Division', () => {
    it('extracts data items with level, name, PIC, USAGE', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '       01  WS-RECORD.',
        '           05  WS-NAME          PIC X(30).',
        '           05  WS-AMOUNT        PIC 9(7)V99 USAGE COMP-3.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.dataItems.length).toBeGreaterThanOrEqual(3);

      const wsName = r.dataItems.find(d => d.name === 'WS-NAME');
      expect(wsName).toBeDefined();
      expect(wsName!.level).toBe(5);
      expect(wsName!.pic).toMatch(/^X\(30\)/);

      const wsAmount = r.dataItems.find(d => d.name === 'WS-AMOUNT');
      expect(wsAmount).toBeDefined();
      expect(wsAmount!.usage).toBe('COMP-3');
    });

    it('extracts 88-level condition names with values', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '       01  WS-STATUS          PIC X.',
        '           88  WS-ACTIVE      VALUE "A".',
        '           88  WS-INACTIVE    VALUE "I".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      const active = r.dataItems.find(d => d.name === 'WS-ACTIVE');
      expect(active).toBeDefined();
      expect(active!.level).toBe(88);
      expect(active!.values).toEqual(['A']);

      const inactive = r.dataItems.find(d => d.name === 'WS-INACTIVE');
      expect(inactive).toBeDefined();
      expect(inactive!.values).toEqual(['I']);
    });

    it('extracts FD entries with record name linkage', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      FILE SECTION.',
        '       FD  EMPLOYEE-FILE.',
        '       01  EMPLOYEE-RECORD.',
        '           05  EMP-ID          PIC 9(5).',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.fdEntries).toHaveLength(1);
      expect(r.fdEntries[0].fdName).toBe('EMPLOYEE-FILE');
      expect(r.fdEntries[0].recordName).toBe('EMPLOYEE-RECORD');
    });

    it('skips FILLER items', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '       01  WS-REC.',
        '           05  FILLER            PIC X(10).',
        '           05  WS-DATA           PIC X(20).',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      const fillerItems = r.dataItems.filter(d => d.name === 'FILLER');
      expect(fillerItems).toHaveLength(0);
      expect(r.dataItems.find(d => d.name === 'WS-DATA')).toBeDefined();
    });

    it('correctly assigns data section (working-storage, linkage, file)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      FILE SECTION.',
        '       FD  MY-FILE.',
        '       01  FILE-REC              PIC X(80).',
        '      WORKING-STORAGE SECTION.',
        '       01  WS-VAR               PIC X(10).',
        '      LINKAGE SECTION.',
        '       01  LK-VAR               PIC X(10).',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');

      const fileRec = r.dataItems.find(d => d.name === 'FILE-REC');
      expect(fileRec).toBeDefined();
      expect(fileRec!.section).toBe('file');

      const wsVar = r.dataItems.find(d => d.name === 'WS-VAR');
      expect(wsVar).toBeDefined();
      expect(wsVar!.section).toBe('working-storage');

      const lkVar = r.dataItems.find(d => d.name === 'LK-VAR');
      expect(lkVar).toBeDefined();
      expect(lkVar!.section).toBe('linkage');
    });
  });

  // -------------------------------------------------------------------------
  // Environment Division
  // -------------------------------------------------------------------------
  describe('Environment Division', () => {
    it('extracts SELECT ... ASSIGN TO with organization, access, record key', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      ENVIRONMENT DIVISION.',
        '      INPUT-OUTPUT SECTION.',
        '       FILE-CONTROL.',
        '           SELECT EMPLOYEE-FILE',
        '               ASSIGN TO "EMPFILE"',
        '               ORGANIZATION IS INDEXED',
        '               ACCESS MODE IS DYNAMIC',
        '               RECORD KEY IS EMP-ID.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.fileDeclarations).toHaveLength(1);
      const fd = r.fileDeclarations[0];
      expect(fd.selectName).toBe('EMPLOYEE-FILE');
      expect(fd.assignTo).toBe('EMPFILE');
      expect(fd.organization).toBe('INDEXED');
      expect(fd.access).toBe('DYNAMIC');
      expect(fd.recordKey).toBe('EMP-ID');
    });
  });

  // -------------------------------------------------------------------------
  // Sequence Numbers (fixed-format COBOL with 000100 cols 1-6)
  // -------------------------------------------------------------------------
  describe('Sequence Numbers', () => {
    it('extracts paragraphs from fixed-format COBOL with numeric sequence numbers', () => {
      // preprocessCobolSource strips cols 1-6, so the extractor sees clean lines
      const src = preprocessCobolSource(cobol(
        '000010 IDENTIFICATION DIVISION.',
        '000020 PROGRAM-ID. SEQPROG.',
        '000030 PROCEDURE DIVISION.',
        '000040 MAIN-PARA.',
        '000050     PERFORM SUB-PARA.',
        '000060 SUB-PARA.',
        '000070     DISPLAY "HI".',
      ));
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.programName).toBe('SEQPROG');
      expect(r.paragraphs.map(p => p.name)).toEqual(['MAIN-PARA', 'SUB-PARA']);
      expect(r.performs).toHaveLength(1);
      expect(r.performs[0].target).toBe('SUB-PARA');
    });

    it('extracts data items from fixed-format COBOL with numeric sequence numbers', () => {
      const src = preprocessCobolSource(cobol(
        '000010 IDENTIFICATION DIVISION.',
        '000020 PROGRAM-ID. SEQPROG.',
        '000030 DATA DIVISION.',
        '000040 WORKING-STORAGE SECTION.',
        '000050 01  WS-AMOUNT              PIC 9(7)V99.',
        '000060 01  WS-NAME                PIC X(30).',
      ));
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.dataItems.map(d => d.name)).toContain('WS-AMOUNT');
      expect(r.dataItems.map(d => d.name)).toContain('WS-NAME');
    });
  });

  // -------------------------------------------------------------------------
  // State Machine
  // -------------------------------------------------------------------------
  describe('State Machine', () => {
    it('correctly transitions between divisions', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      ENVIRONMENT DIVISION.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '       01  WS-VAR              PIC X(10).',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           DISPLAY WS-VAR.',
        '           STOP RUN.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.programName).toBe('TESTPROG');
      expect(r.dataItems.find(d => d.name === 'WS-VAR')).toBeDefined();
      expect(r.paragraphs).toHaveLength(1);
      expect(r.paragraphs[0].name).toBe('MAIN-PARA');
    });

    it('handles continuation lines (indicator "-" in column 7)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           CALL "VERY-LONG-PR',
        '      -    "OGRAM-NAME".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      // Continuation merges lines; at minimum verify no crash and paragraph found
      expect(r.paragraphs).toHaveLength(1);
      expect(r.paragraphs[0].name).toBe('MAIN-PARA');
    });

    it('skips comment lines (indicator "*" or "/" in column 7)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '      *    THIS IS A COMMENT',
        '      /    THIS IS A PAGE BREAK COMMENT',
        '           CALL "REALPROG".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].target).toBe('REALPROG');
    });
  });

  // -------------------------------------------------------------------------
  // EXEC Blocks
  // -------------------------------------------------------------------------
  describe('EXEC Blocks', () => {
    it('extracts EXEC SQL blocks with tables and host variables', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           EXEC SQL',
        '             SELECT EMP-NAME, EMP-SALARY',
        '             FROM EMPLOYEE',
        '             WHERE EMP-ID = :WS-EMP-ID',
        '           END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.execSqlBlocks).toHaveLength(1);
      const sql = r.execSqlBlocks[0];
      expect(sql.operation).toBe('SELECT');
      expect(sql.tables).toContain('EMPLOYEE');
      expect(sql.hostVariables).toContain('WS-EMP-ID');
    });

    it('extracts EXEC CICS blocks with command and MAP/PROGRAM/TRANSID', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           EXEC CICS SEND MAP('EMPMAP')",
        "             PROGRAM('EMPPROG')",
        "             TRANSID('EMPT')",
        '           END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.execCicsBlocks).toHaveLength(1);
      const cics = r.execCicsBlocks[0];
      expect(cics.command).toBe('SEND MAP');
      expect(cics.mapName).toBe('EMPMAP');
      expect(cics.programName).toBe('EMPPROG');
      expect(cics.transId).toBe('EMPT');
    });

    it('handles single-line EXEC SQL ... END-EXEC', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           EXEC SQL DELETE FROM ORDERS WHERE ORD-ID = :WS-ORD END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.execSqlBlocks).toHaveLength(1);
      expect(r.execSqlBlocks[0].operation).toBe('DELETE');
      expect(r.execSqlBlocks[0].tables).toContain('ORDERS');
    });

    it('handles multi-line EXEC SQL ... END-EXEC', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           EXEC SQL',
        '             INSERT INTO AUDIT_LOG',
        '             VALUES (:WS-TIMESTAMP, :WS-USER)',
        '           END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.execSqlBlocks).toHaveLength(1);
      const sql = r.execSqlBlocks[0];
      expect(sql.operation).toBe('INSERT');
      expect(sql.tables).toContain('AUDIT_LOG');
      expect(sql.hostVariables).toContain('WS-TIMESTAMP');
      expect(sql.hostVariables).toContain('WS-USER');
    });
  });

  // -------------------------------------------------------------------------
  // Linkage & Data Flow
  // -------------------------------------------------------------------------
  describe('Linkage & Data Flow', () => {
    it('extracts PROCEDURE DIVISION USING parameters', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      LINKAGE SECTION.',
        '       01  LK-PARAM1            PIC X(10).',
        '       01  LK-PARAM2            PIC 9(5).',
        '      PROCEDURE DIVISION USING LK-PARAM1 LK-PARAM2.',
        '       MAIN-PARA.',
        '           DISPLAY LK-PARAM1.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.procedureUsing).toEqual(['LK-PARAM1', 'LK-PARAM2']);
    });

    it('extracts ENTRY points with USING', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           ENTRY "ALTENTRY" USING WS-PARAM1 WS-PARAM2.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.entryPoints).toHaveLength(1);
      expect(r.entryPoints[0].name).toBe('ALTENTRY');
      expect(r.entryPoints[0].parameters).toEqual(['WS-PARAM1', 'WS-PARAM2']);
    });

    it('extracts MOVE statements (skipping figurative constants)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           MOVE WS-SOURCE TO WS-TARGET.',
        '           MOVE SPACES TO WS-BLANK.',
        '           MOVE ZEROS TO WS-ZERO.',
        '           MOVE CORRESPONDING WS-REC1 TO WS-REC2.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      const moveTargets = r.moves.map(m => ({ from: m.from, to: m.to, corr: m.corresponding }));
      expect(moveTargets).toContainEqual({ from: 'WS-SOURCE', to: 'WS-TARGET', corr: false });
      expect(moveTargets).toContainEqual({ from: 'WS-REC1', to: 'WS-REC2', corr: true });
      expect(r.moves.find(m => m.from === 'SPACES')).toBeUndefined();
      expect(r.moves.find(m => m.from === 'ZEROS')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Edge Cases
  // -------------------------------------------------------------------------
  describe('Edge Cases', () => {
    it('empty program returns empty results', () => {
      const r = extractCobolSymbolsWithRegex('', 'empty.cbl');
      expect(r.programName).toBeNull();
      expect(r.paragraphs).toHaveLength(0);
      expect(r.sections).toHaveLength(0);
      expect(r.performs).toHaveLength(0);
      expect(r.calls).toHaveLength(0);
      expect(r.copies).toHaveLength(0);
      expect(r.dataItems).toHaveLength(0);
      expect(r.fileDeclarations).toHaveLength(0);
      expect(r.fdEntries).toHaveLength(0);
      expect(r.execSqlBlocks).toHaveLength(0);
      expect(r.execCicsBlocks).toHaveLength(0);
      expect(r.procedureUsing).toHaveLength(0);
      expect(r.entryPoints).toHaveLength(0);
      expect(r.moves).toHaveLength(0);
    });

    it('extracts AUTHOR and DATE-WRITTEN from program metadata', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '       AUTHOR. JOHN DOE.',
        '       DATE-WRITTEN. 2025-01-15.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.programMetadata.author).toBe('JOHN DOE');
      expect(r.programMetadata.dateWritten).toBe('2025-01-15');
    });
  });
});
