---
name: ras-test-case-executor
version: 1.0.0
author: RAS Testing Team
license: MIT
description: "Execute RAS OAuth workflow test cases defined in Excel workbooks. Parses test case specifications with natural language step descriptions, maps them to workflow step IDs, constructs CLI commands, and executes the RAS workflow runner with audit logging and screenshot capture. Supports both CTDC and C3DC test suites."
argument-hint: "Provide the path to an Excel workbook (.xlsx) containing test case definitions with columns: Case_ID, TestName, Test Steps, System, User. Case_ID may repeat across rows (e.g. one user identity with several sub-tests), so Case_ID + TestName combined is the unique test identifier. Optionally specify which test cases to run (e.g., 'auth_idme, full_workflow') or execute all rows."
user-invocable: true
---

# RAS Test Case Executor from Excel

**Purpose:** Execute RAS OAuth workflow test cases defined in Excel workbooks. Parses test case specifications, maps natural language test steps to corresponding workflow step IDs, constructs the appropriate CLI commands, and executes the RAS workflow runner with audit logging and screenshot capture.

**Input:** Excel workbook (.xlsx) containing test case definitions  
**Output:** Workflow execution logs and audit artifacts (JSON, text, and screenshots)  
**Scope:** RAS Testing workspace — applicable to both CTDC and C3DC test suites

---

## What It Does and Workflow Steps  

This skill automates the execution of RAS test cases by performing the following operations:

1. **Parsing Excel Input** — Reads a workbook with columns:
   - `Case_ID` — Test case/user identifier. **Not guaranteed unique** — the same `Case_ID` (e.g. a shared user identity) commonly repeats across several rows, each covering a different scenario for that user.
   - `TestName` — Human-readable name of the specific scenario/row (e.g. "Get Authenticated", "Users without a linked eRA").
   - `Test Steps` — Comma-separated natural language descriptions of steps to execute
   - `System` — File path to system.env (shared RAS configuration)
   - `User` — File path to user.env (user-specific credentials and settings)
   - `Validate` — Pass/fail criteria in natural language (used later by the validator skill)
   - `Note` — Optional free-text reference/annotation, not used in execution

   **Building the test identifier:** Since `Case_ID` alone can repeat across rows, combine `Case_ID` and `TestName` into a single slugified string and use that combination — not the bare `Case_ID` — as the `--test-case` value (and therefore as the output filename base, since the workflow runner names log files after `--test-case`). Slugify by trimming both values, then joining with an underscore and replacing any run of non-alphanumeric characters with `_`, e.g.:

   ```
   Case_ID:   "yizhen.chen_id_green_file"
   TestName:  "Users without a linked eRA "
   → testname: "yizhen.chen_id_green_file_Users_without_a_linked_eRA"
   ```

   Verify that:
   - All file paths in `System` and `User` columns exist and are readable
   - The combined `Case_ID`+`TestName` values are unique across rows (used as test identifiers); if a collision remains after combining, append the row number
   - `Test Steps` contain only recognized keywords (see mapping table above)


2. **Mapping Steps** — Converts natural language step descriptions to step IDs:
   - "authorize login" or "authenticate" → `1`
   - "exchange code" or "get tokens" → `2`
   - "userinfo" → `3`
   - "decode passport" or "parse visa" → `4`
   - "validate visa" → `5`
   - "drs access" or "request access" → `6`
   - "verify url" or "signed url" → `7`
   - "refresh token" → `8`
   - "revoke token" → `9`
   - "logout" → `10`
   - "export" or "context" → `11`
   - "consent group" or "consent codes" or "get consent groups" → `12`

   **Note:** Step 12 (`get-consent-groups`) requires step 4 (`decode-passport`) to have already run in the same invocation — it reads the passport's second visa JWT for the `ras_dbgap_permissions` claim. Always include `4` in `--steps` whenever `12` is used, e.g. `--steps 1,2,3,4,12`.

3. **Constructing CLI** — Builds the npm command, passing the combined `Case_ID`+`TestName` identifier (not the bare `Case_ID`) as `--test-case`:
   ```bash
   npm run workflow:run -- \
     --steps <ID>,<ID>... \
     --system-settings file://<system_path> \
     --user-settings file://<user_path> \
     --test-case <Case_ID>_<TestName>
   ```

    Example for a `yizhen.chen_id_green_file` / "Get Authenticated" row
   ```bash
      npm run workflow:run -- \
      --steps 1,2,3 \
      --system-settings file:///Users/someone/Documents/RAS-Testing/CTDC/system.env \
      --user-settings file:///Users/someone/Documents/RAS-Testing/CTDC/yizhen.chen_id_purple_file.env \
      --test-case yizhen.chen_id_green_file_Get_Authenticated
   ```
4. **Executing Tests** — Runs the constructed command and captures output to:
   - `test-results/workflow-logs/<Case_ID>_<TestName>-<timestamp>.json`
   - `test-results/workflow-logs/<Case_ID>_<TestName>-<timestamp>.log`
   - `test-results/screenshots/` (screenshots from authorization flows)

---


## Excel Workbook Format

### Required Columns

| Column | Type | Example | Notes |
|--------|------|---------|-------|
| Case_ID | String | `yizhen.chen_id_green_file` | Test/user identifier; **may repeat** across multiple rows |
| TestName | String | `Get Authenticated` | Human-readable scenario name for this row; unique together with `Case_ID` |
| Test Steps | String | `authorize login, exchange code, userinfo, validate visa` | Comma-separated natural language; order matters |
| System | String | `/Users/cheny39/Documents/RAS-Testing/CTDC/system.env` | Absolute or relative path to shared settings |
| User | String | `/Users/cheny39/Documents/RAS-Testing/CTDC/id.me.env` | Absolute or relative path to user credentials |
| Validate | String | `Pass: ... Fail: ...` | Optional; pass/fail criteria consumed by the validator skill |
| Note | String | `3. B. Authorized Data Access Test Details` | Optional; free-text reference, not used in execution |

**Test identifier used in output filenames:** `<Case_ID>_<TestName>` (slugified), not `Case_ID` alone — see "Building the test identifier" above.

### Example Row

```
Case_ID: "yizhen.chen_id_green_file"
TestName: "receive the RAS Passport"
Test Steps: "authorize login, exchange code, userinfo, decode passport, validate visa"
System: "/Users/cheny39/Documents/RAS-Testing/CTDC/system.env"
User: "/Users/cheny39/Documents/RAS-Testing/CTDC/yizhen.chen_id_purple_file.env"
→ testname used for --test-case / output files: "yizhen.chen_id_green_file_receive_the_RAS_Passport"
```

### Multiple Test Cases (same Case_ID, different TestName)

| Case_ID | TestName | Test Steps | System | User | Combined testname |
|---------|----------|-----------|--------|------|--------------------|
| yizhen.chen_id_green_file | Get Authenticated | authorize login, exchange code, userinfo, decode passport, validate visa | CTDC/system.env | CTDC/yizhen.chen_id_purple_file.env | yizhen.chen_id_green_file_Get_Authenticated |
| yizhen.chen_id_green_file | Users without a linked eRA | authorize login | CTDC/system.env | CTDC/yizhen.chen_id_purple_file.env | yizhen.chen_id_green_file_Users_without_a_linked_eRA |
| yizhen.chen_id_green_file | refresh access tokens | authorize login, exchange code, userinfo, refresh token | CTDC/system.env | CTDC/yizhen.chen_id_purple_file.env | yizhen.chen_id_green_file_refresh_access_tokens |



## Natural Language Mapping

The skill recognizes these keywords and phrases (case-insensitive):

- **Step 1:** `auth`, `authorize`, `login`, `sign in`, `signin`
- **Step 2:** `exchange`, `token`, `code`, `get tokens`
- **Step 3:** `userinfo`, `user info`, `profile`
- **Step 4:** `decode`, `passport`, `visa`, `parse`
- **Step 5:** `validate`, `validation`
- **Step 6:** `drs`, `access`, `request`, `download`
- **Step 7:** `verify`, `signed url`, `url`, `storage`
- **Step 8:** `refresh`
- **Step 9:** `revoke`
- **Step 10:** `logout`, `session`
- **Step 11:** `export`, `context`, `snapshot`
- **Step 12:** `consent`, `consent group`, `consent code`, `dbgap permissions`

**Ambiguity Resolution:** If a step description matches multiple keywords (e.g., "refresh and revoke"), prioritize by first match in the list above.

---

## Error Handling

### Missing or Invalid Excel File
**Issue:** File not found or not a valid .xlsx  
**Action:** Report file path and error; ask user to verify file location

### Invalid File Paths
**Issue:** `System` or `User` column contains non-existent file paths  
**Action:** Report the invalid path and the combined `Case_ID`+`TestName` identifier; suggest checking for typos or relative paths

### Unrecognized Step Keywords
**Issue:** `Test Steps` column contains unknown keywords  
**Action:** Report the unrecognized keyword and suggest closest matches from reference list

### CLI Execution Failure
**Issue:** `npm run workflow:run` exits with non-zero code  
**Action:** Capture stderr and stdout; include in summary report; provide artifact paths for debugging

### Missing Columns
**Issue:** Excel workbook missing required columns (Case_ID, TestName, Test Steps, System, User)  
**Action:** Report which columns are missing and provide template example

### Duplicate Combined Identifiers
**Issue:** Two rows produce the same slugified `Case_ID`+`TestName` combination  
**Action:** Append the row number (or a numeric suffix) to disambiguate, and warn the user that the workbook has duplicate `TestName` values for that `Case_ID`
