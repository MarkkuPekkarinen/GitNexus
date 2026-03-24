# COBOL Deep Indexing

Beyond basic symbol extraction (program name, paragraphs, CALL, PERFORM, COPY), GitNexus performs deep indexing of COBOL-specific constructs: data items, EXEC SQL/CICS blocks, file declarations, FD entries, ENTRY points, and MOVE statements.

## Data Items

### Level Numbers

| Level Range | Meaning | Graph Node Type |
|-------------|---------|-----------------|
| 01 | Record (group item) | `Record` |
| 02-49 | Elementary/group items | `Property` |
| 66 | RENAMES | `Property` |
| 77 | Independent item | `Property` |
| 88 | Condition name | `Const` |

FILLER items are skipped (no useful name for the graph).

### Clauses Parsed

The `parseDataItemClauses()` function extracts these clauses from the trailing text of a data item declaration:

| Clause | Pattern | Example |
|--------|---------|---------|
| `PIC` / `PICTURE` | `\bPIC(?:TURE)?\s+(?:IS\s+)?(\S+)` | `PIC X(30)`, `PICTURE IS 9(5)V99` |
| `USAGE` | `\bUSAGE\s+(?:IS\s+)?(COMP\|BINARY\|...)` | `USAGE IS COMP-3`, `BINARY` |
| `REDEFINES` | `\bREDEFINES\s+([A-Z][A-Z0-9-]+)` | `REDEFINES WK-DATE-NUM` |
| `OCCURS` | `\bOCCURS\s+(\d+)` | `OCCURS 12 TIMES` |

Standalone COMP variants (without the `USAGE` keyword) are also detected: `COMP`, `COMP-1` through `COMP-6`, `COMP-X`, `BINARY`, `PACKED-DECIMAL`.

### Data Hierarchy

Data items form a hierarchical structure based on level numbers. The extractor uses a **stack algorithm**:

```
Processing order:
  01 WK-RECORD          -> push {01, WK-RECORD}   -> parent: Module
  05 WK-NAME            -> push {05, WK-NAME}     -> parent: WK-RECORD (01 < 05)
  10 WK-FIRST           -> push {10, WK-FIRST}    -> parent: WK-NAME (05 < 10)
  10 WK-LAST            -> pop WK-FIRST, push      -> parent: WK-NAME (05 < 10)
  05 WK-CODE            -> pop WK-LAST, WK-NAME    -> parent: WK-RECORD (01 < 05)
  88 WK-ACTIVE          -> (88 handled separately)  -> parent: WK-CODE
```

The stack maintains items where each entry's level is strictly less than the next. When a new item arrives with a level <= the top of stack, items are popped until the stack top has a smaller level. A `CONTAINS` edge is created from the stack top to the new item.

For 88-level condition names, the parent is the immediately preceding non-88 data item (found by scanning backwards).

### Annotated Example

```cobol
       01  WK-EMPLOYEE.
           05  WK-EMP-ID          PIC 9(6).
           05  WK-EMP-NAME        PIC X(30).
           05  WK-EMP-STATUS      PIC X(01).
               88  WK-ACTIVE      VALUE "A".
               88  WK-INACTIVE    VALUE "I".
           05  WK-SALARY          PIC 9(7)V99 COMP-3.
           05  WK-DEPT            PIC X(04) OCCURS 3 TIMES.
```

Produces:
- `Record` node: `WK-EMPLOYEE` (level 01, section: working-storage)
- `Property` nodes: `WK-EMP-ID`, `WK-EMP-NAME`, `WK-EMP-STATUS`, `WK-SALARY`, `WK-DEPT`
- `Const` nodes: `WK-ACTIVE` (values: `A`), `WK-INACTIVE` (values: `I`)
- `CONTAINS` edges: `WK-EMPLOYEE -> WK-EMP-ID`, `WK-EMPLOYEE -> WK-EMP-NAME`, etc.
- `CONTAINS` edges: `WK-EMP-STATUS -> WK-ACTIVE`, `WK-EMP-STATUS -> WK-INACTIVE`

### Data Item Cap

A maximum of **500 data items per file** (`MAX_DATA_ITEMS_PER_FILE`) are processed. Some COBOL programs (especially after COPY expansion) can have 10,000+ data items, which would cause graph bloat and push the V8 relationship Map past its 16.7M entry limit across thousands of files.

The cap applies after extraction: the first 500 items in source order are kept. Since 01-level records appear first, critical top-level structure is preserved.

## EXEC SQL

EXEC SQL blocks are accumulated across lines between `EXEC SQL` and `END-EXEC`, then parsed as a unit.

### Operation Classification

The first SQL keyword determines the operation:

| First Keyword | Operation |
|---------------|-----------|
| `SELECT` | SELECT |
| `INSERT` | INSERT |
| `UPDATE` | UPDATE |
| `DELETE` | DELETE |
| `DECLARE` | DECLARE |
| `OPEN` | OPEN |
| `CLOSE` | CLOSE |
| `FETCH` | FETCH |
| *(anything else)* | OTHER |

### Table Extraction

Tables are extracted from SQL clauses:

| Clause Pattern | Example |
|----------------|---------|
| `FROM <table>` | `SELECT * FROM EMPLOYEES` |
| `INTO <table>` | `INSERT INTO EMPLOYEES` |
| `UPDATE <table>` | `UPDATE EMPLOYEES SET ...` |
| `JOIN <table>` | `LEFT JOIN DEPARTMENTS ON ...` |

### Cursor Detection

```cobol
           EXEC SQL
               DECLARE C-EMPLOYEES CURSOR FOR
               SELECT EMP-ID, EMP-NAME FROM EMPLOYEES
               WHERE DEPT = :WK-DEPT
           END-EXEC
```

Extracts: cursor `C-EMPLOYEES`, table `EMPLOYEES`, host variable `WK-DEPT`.

### Host Variables

Host variables are COBOL variables referenced in SQL with a `:` prefix. The colon is stripped:

```sql
WHERE EMP-ID = :WK-EMP-ID AND DEPT = :WK-DEPT
```

Extracts: `WK-EMP-ID`, `WK-DEPT`.

### Graph Output

- `CodeElement` node per table, with description `sql-table op:{OP}`
- `CodeElement` node per cursor, with description `sql-cursor`
- `ACCESSES` edge from Module to each CodeElement
- Deduplication: if the same table appears in multiple SQL blocks, only one node is created

## EXEC CICS

EXEC CICS blocks are accumulated and parsed similarly to SQL blocks.

### Command Detection

Two-word commands are detected first (matched against the block start):

```
SEND MAP, RECEIVE MAP, SEND TEXT, SEND CONTROL, READ NEXT, READ PREV
```

If no two-word command matches, the first word is used (e.g., `LINK`, `XCTL`, `RETURN`, `READ`, `WRITE`).

### Extraction

| Element | Pattern | Example |
|---------|---------|---------|
| MAP name | `MAP('name')` or `MAP("name")` | `EXEC CICS SEND MAP('EMPMENU')` |
| PROGRAM name | `PROGRAM('name')` or `PROGRAM("name")` | `EXEC CICS LINK PROGRAM('BGTABUP')` |
| TRANSID | `TRANSID('name')` or `TRANSID("name")` | `EXEC CICS START TRANSID('EMP1')` |

### Graph Output

- MAP: `CodeElement` node with description `cics-map cmd:{CMD}` + `ACCESSES` edge from Module
- PROGRAM: `CALLS` edge (cross-program call via CICS LINK/XCTL)
- TRANSID: `CodeElement` node with description `cics-transid cmd:{CMD}` + `ACCESSES` edge from Module

### Annotated Example

```cobol
           EXEC CICS
               SEND MAP('EMPMENU')
               MAPSET('EMPSET')
               FROM(WK-MAP-DATA)
               ERASE
           END-EXEC
```

Produces:
- `CodeElement` node: `EMPMENU` (description: `cics-map cmd:SEND MAP`)
- `ACCESSES` edge: Module -> `EMPMENU`

## File Declarations

SELECT statements in the INPUT-OUTPUT SECTION are accumulated across multiple lines (until a period terminator) and parsed for:

| Clause | Pattern | Example |
|--------|---------|---------|
| SELECT | `SELECT <name>` | `SELECT MASTER-FILE` |
| ASSIGN | `ASSIGN TO <file>` | `ASSIGN TO "MASTER.DAT"` |
| ORGANIZATION | `ORGANIZATION IS <type>` | `ORGANIZATION IS INDEXED` |
| ACCESS | `ACCESS MODE IS <mode>` | `ACCESS MODE IS DYNAMIC` |
| RECORD KEY | `RECORD KEY IS <field>` | `RECORD KEY IS WK-EMP-ID` |
| FILE STATUS | `FILE STATUS IS <field>` | `FILE STATUS IS WK-FILE-STATUS` |

### Graph Output

- `CodeElement` node with description containing all parsed clauses (e.g., `select org:INDEXED access:DYNAMIC key:WK-EMP-ID status:WK-FILE-STATUS assign:MASTER.DAT`)
- `RECORD_KEY_OF` edge: from Property node to CodeElement (confidence 0.8)
- `FILE_STATUS_OF` edge: from Property node to CodeElement (confidence 0.8)

## FD Entries

FD (File Description) entries associate a file name with its record layout:

```cobol
       FD  MASTER-FILE.
       01  MASTER-RECORD.
           05  MR-EMP-ID       PIC 9(6).
           05  MR-EMP-NAME     PIC X(30).
```

The extractor tracks `pendingFdName` state: when an `FD` line is seen, the next 01-level data item becomes its record.

### Graph Output

- `CodeElement` node with description `fd record:{recordName}`
- `CONTAINS` edge: FD CodeElement -> Record node
- `CONTAINS` edge: SELECT CodeElement -> FD CodeElement (linking file declaration to file description)

## ENTRY Points

The `ENTRY` statement defines additional entry points into a COBOL program (in addition to the main program entry):

```cobol
       ENTRY "SUBPROG" USING WK-PARAM-1 WK-PARAM-2.
```

### Graph Output

- `Constructor` node with description `entry params:{param1},{param2}` (or just `entry` if no parameters)
- `CONTAINS` edge: Module -> Constructor
- Symbol table entry (so the entry point is discoverable by name)

## PROCEDURE DIVISION USING

```cobol
       PROCEDURE DIVISION USING WK-INPUT-REC WK-OUTPUT-REC.
```

The USING clause identifies parameters received by the program from its caller.

### Graph Output

- `RECEIVES` edge: Module -> Property (for each parameter name, confidence 0.8)

## MOVE Statements

MOVE statements are extracted but currently only stored in the regex results (not emitted as graph edges):

```cobol
       MOVE WK-NAME TO OUT-NAME.
       MOVE CORRESPONDING WK-INPUT TO WK-OUTPUT.
```

### Extraction Details

- Source and target identifiers are captured
- `CORRESPONDING` keyword is tracked (bulk field-by-field move)
- Figurative constants (SPACES, ZEROS, LOW-VALUES, HIGH-VALUES, QUOTES, ALL) are skipped
- The enclosing paragraph (`caller`) is tracked for context

DATA_FLOW edges from MOVE statements are reserved for a future release.

## Source Files

- `gitnexus/src/core/ingestion/cobol-preprocessor.ts` -- All extraction logic, clause parsers, EXEC block parsers
- `gitnexus/src/core/ingestion/workers/parse-worker.ts` -- `processCobolRegexOnly()`, graph node/edge emission
- `gitnexus/src/core/ingestion/parsing-processor.ts` -- Sequential fallback with same `MAX_DATA_ITEMS_PER_FILE` cap
