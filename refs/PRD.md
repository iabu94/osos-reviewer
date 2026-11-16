# Product Requirements Document (PRD)

## Teams-Triggered Token-Efficient Cross-Repository Code Review Orchestrator

**Version:** 1.1\
**Status:** Updated draft\
**Primary AI review agent:** Claude Code\
**Target organization:** Centroniz

------------------------------------------------------------------------

## 1. Document Overview

### 1.1 Objective

Build a Teams-triggered code review orchestration system that analyzes
pull requests across the .NET backend and Angular frontend repositories.

The system will use Claude Code in headless mode as its primary review
agent. It will provide Claude Code with compact, relevant context
through MCP tools backed by:

-   AST-based code intelligence and symbol indexing.
-   Cross-repository API and dependency tracing.
-   A RAG-based knowledge base for coding standards, architecture
    guidelines, and technical documentation.
-   Git diff and pull-request metadata.

The goal is to improve review consistency, identify frontend/backend
integration mismatches, detect potential duplication and impact, and
reduce unnecessary context sent to the model.

### 1.2 Goals

1.  Trigger code reviews from Microsoft Teams using a pull-request URL.
2.  Identify the relevant backend and frontend repositories and pair
    branches using a ticket identifier.
3.  Analyze changed code using Git diffs and AST-based indexing.
4.  Retrieve relevant code symbols, dependencies, API contracts, and
    coding standards on demand.
5.  Use Claude Code as the primary agent to produce structured review
    findings.
6.  Return review results to the originating Teams thread.
7.  Keep model context focused by retrieving only relevant information
    rather than supplying entire repositories or documentation sets.

### 1.3 Non-Goals

The initial release will not:

-   Support multiple interchangeable AI agents or model providers.
-   Run model inference locally through Ollama.
-   Automatically modify source code or commit fixes.
-   Automatically approve, merge, or close pull requests.
-   Guarantee detection of every defect or integration mismatch.
-   Require a full repository re-index for every review.

------------------------------------------------------------------------

## 2. Target Users

-   Software Engineers
-   Technical Leads
-   Pull Request Reviewers
-   Engineering Managers

The initial target environment is the Centroniz engineering workflow,
particularly projects with Angular frontend and .NET backend
repositories.

------------------------------------------------------------------------

## 3. Product Principles and Key Decisions

### 3.1 Claude Code is the Primary Review Agent

Claude Code will be invoked in headless mode using its supported
command-line interface, for example:

``` bash
claude -p
```

The orchestrator will prepare the review context and expose retrieval
capabilities through a local MCP server.

The initial implementation is specifically designed around Claude Code.
The RAG engine, code-indexing services, and MCP server should remain
modular so they can be reused independently in future work. A
multi-agent or multi-model abstraction is not required for the initial
release.

### 3.2 Separate Code Intelligence and Document RAG

The system will provide two distinct retrieval capabilities:

**Code Intelligence** - AST-derived symbols and signatures. - API
endpoints, DTOs, interfaces, and service methods. - Cross-repository
contract relationships. - Symbol references and dependency
relationships. - Similarity search for potentially reusable code.

**Document RAG** - Coding standards. - Architecture guidelines. -
Security guidelines. - Database and framework conventions. - Engineering
documentation.

Both capabilities may use the same PostgreSQL instance and pgvector
extension, but their data models, ingestion processes, and retrieval
behavior must remain logically separated.

### 3.3 Token-Efficient, Not Zero-Token

The system cannot perform an LLM-generated review without model tokens.
The product objective is therefore token efficiency: retrieve and
provide only the context relevant to the current pull request.

The product must not claim zero-token reviews.

------------------------------------------------------------------------

## 4. High-Level Architecture

``` text
Microsoft Teams
      |
      | @ReviewBot + Pull Request URL
      v
Teams Webhook / Bot Endpoint
      |
      v
Local Orchestrator
      |
      +-- Parse PR metadata and ticket ID
      |
      +-- Resolve repositories and branches
      |
      +-- Create / manage Git worktrees
      |
      +-- Generate focused Git diff
      |
      +-- Trigger delta AST indexing
      |
      +-- Prepare review request
      |
      v
Claude Code (Headless: claude -p)
      |
      | MCP tool calls
      v
Local MCP Server
      |
      +-- trace_fe_be_integration()
      +-- trace_symbol_impact()
      +-- check_reusability()
      +-- get_coding_standards()
      |
      +--------------------------+
      |                          |
      v                          v
Code Intelligence          Document RAG
      |                          |
      +------------+-------------+
                   |
                   v
          PostgreSQL + pgvector
                   |
                   v
       Structured Review Findings
                   |
                   v
       Teams Adaptive Card Reply
```

### 4.1 Main Components

1.  **Teams Trigger Endpoint:** Receives and validates review requests.
2.  **Orchestrator:** Coordinates Git operations, indexing, Claude Code
    execution, and response delivery.
3.  **Repository Manager:** Creates and cleans up isolated Git
    worktrees.
4.  **Code Intelligence Engine:** Parses source code and maintains
    symbol and dependency data.
5.  **Knowledge Ingestion and RAG Engine:** Indexes Markdown and other
    approved engineering documentation.
6.  **MCP Server:** Exposes narrowly scoped retrieval tools to Claude
    Code.
7.  **Review Engine:** Uses Claude Code to analyze the PR and produce
    structured findings.
8.  **Teams Response Adapter:** Formats and posts results to the
    original Teams thread.

------------------------------------------------------------------------

## 5. Functional Requirements

### 5.1 Teams Trigger and Pull Request Resolution

-   The system must accept a Teams message that mentions `@ReviewBot`
    and includes a supported pull-request URL.
-   The endpoint must validate the incoming request before starting a
    review.
-   The system must identify the source repository, source branch,
    target branch, and pull-request identifier.
-   The system must extract a ticket identifier from the branch name or
    pull-request metadata using a configurable pattern. The initial
    default pattern is:

``` regex
[A-Z]+-\d+
```

-   If a ticket identifier cannot be resolved, the system must report
    the issue and follow a defined fallback policy rather than silently
    pairing unrelated branches.
-   The system must retain the originating Teams conversation or thread
    reference for the response.

### 5.2 Cross-Repository Git Worktree Management

-   The orchestrator must check out the pull-request branch in an
    isolated worktree for the primary repository.
-   It must generate a focused diff against the pull request's target
    branch, using a command equivalent to:

``` bash
git diff origin/<target>...HEAD -U2
```

-   Generated files, dependency lockfiles, and other low-value files may
    be excluded through configurable rules. Exclusions must not hide
    relevant source changes or tests needed to understand the PR.
-   The system must search the companion repository for a branch
    containing the same ticket identifier.
-   If a matching companion branch exists, it must use that branch for
    cross-repository analysis.
-   If no matching branch exists, it must use a configured baseline
    branch such as `origin/develop` or `origin/main`.
-   The selected companion branch and fallback decision must be included
    in review metadata.
-   Worktrees and temporary resources must be cleaned up after the
    review, including on failure.

### 5.3 Code Intelligence and AST Indexing

The system must maintain a persistent baseline index and update it
incrementally when relevant repository changes are detected.

#### Backend (.NET / EF Core)

The initial parser should identify:

-   Controllers and endpoint routes.
-   Minimal API route definitions, where used.
-   Request and response DTOs.
-   Service methods and relevant method signatures.
-   FluentValidation rules.
-   Entity Framework Core entities.
-   `DbContext` configurations, including `IEntityTypeConfiguration<T>`.
-   Relevant references and dependencies between indexed symbols.

#### Frontend (Angular / TypeScript)

The initial parser should identify:

-   Angular services and `HttpClient` calls.
-   API endpoint paths and HTTP methods.
-   TypeScript interfaces and DTO-like types.
-   Components and relevant inputs/outputs.
-   Reactive signals and related public contracts, where used.
-   References between services, interfaces, and components.

#### Indexing Requirements

-   Indexing must support full initial indexing and incremental/delta
    indexing.
-   Each indexed record must include repository, branch or revision,
    file path, symbol type, symbol name, source location, signature, and
    available summary or relationship metadata.
-   The index must be traceable to a Git commit or equivalent repository
    revision.
-   Updates must avoid leaving stale records for deleted or renamed
    symbols.
-   The implementation must define how baseline records and PR-specific
    changes are represented and queried.

### 5.4 Code Intelligence Data Model

The initial logical data model should include the following entities:

**Code symbols** - Repository identifier. - Branch or revision
identifier. - Symbol type. - Symbol name. - File path. - Start and end
line. - Signature. - Summary, when available. - Embedding, when
generated. - Commit or revision metadata.

**Code relationships** - Source symbol. - Target symbol. - Relationship
type, such as calls, references, implements, maps to, or exposes. -
Repository and revision context. - Source location, where available.

A preliminary pgvector-backed symbol table may use the following
structure:

``` sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE code_symbols (
    id BIGSERIAL PRIMARY KEY,
    repo VARCHAR(20) NOT NULL,
    revision VARCHAR(100) NOT NULL,
    branch_tag VARCHAR(100),
    symbol_type VARCHAR(50) NOT NULL,
    symbol_name VARCHAR(255) NOT NULL,
    file_path TEXT NOT NULL,
    line_start INT,
    line_end INT,
    signature TEXT NOT NULL,
    summary TEXT,
    embedding vector(768),
    commit_sha VARCHAR(64) NOT NULL
);
```

The embedding dimension shown is provisional. It must match the selected
embedding model. The final schema and indexes will be confirmed in the
Technical Design Document.

### 5.5 Document Knowledge Base and RAG

The system must support an engineering knowledge base containing
Markdown (`.md`) files and other explicitly supported documentation
formats.

Example structure:

``` text
knowledge-base/
├── coding-standards/
│   ├── angular/
│   │   ├── components.md
│   │   └── services.md
│   ├── dotnet/
│   │   ├── controllers.md
│   │   └── repositories.md
│   └── database/
│       └── postgresql.md
├── architecture/
│   ├── system-architecture.md
│   └── integration-guidelines.md
└── security/
    └── secure-development.md
```

#### Ingestion Requirements

-   Discover and read configured knowledge-base documents.
-   Split documents into meaningful chunks while preserving headings and
    section context.
-   Generate embeddings for chunks using a configured embedding model.
-   Store chunk text, source path, document title, section or heading,
    category, version or content hash, and embedding.
-   Support incremental re-indexing when documents are added, modified,
    or deleted.
-   Avoid duplicate chunks when the source content has not changed.
-   Preserve the original source location so findings can refer
    reviewers to the relevant standard.
-   Allow the knowledge base to be refreshed without re-indexing
    application source code.

#### Retrieval Requirements

-   Retrieve only standards relevant to the changed code and review
    question.
-   Support filtering by technology, repository, document category, or
    other available metadata.
-   Use semantic retrieval and, where appropriate, keyword or exact
    matching.
-   Return concise rule text with source document and section metadata.
-   Allow the review agent to identify the source standard behind a
    reported violation.

The initial implementation will expose this capability through
`get_coding_standards()`.

### 5.6 MCP Tools for Claude Code

The local MCP server will expose four primary tools.

#### Tool 1: `trace_fe_be_integration()`

Purpose: - Cross-reference backend endpoints and DTOs against Angular
HTTP clients and TypeScript interfaces. - Identify potential endpoint,
HTTP method, request/response shape, and naming mismatches. - Return
evidence such as relevant symbols, file paths, signatures, and source
locations.

#### Tool 2: `trace_symbol_impact()`

Purpose: - Identify references and dependencies affected by changed
symbols. - Trace relevant call relationships and contract dependencies
across repositories. - Return impacted symbols and their source
locations.

#### Tool 3: `check_reusability()`

Purpose: - Search for potentially reusable components, helpers,
services, extension methods, and other relevant implementations. - Use
vector similarity as one signal, supported by symbol and structural
information where available. - Return candidate implementations with
paths and concise explanations. - Treat similarity results as candidates
for human/agent evaluation, not proof of duplication.

#### Tool 4: `get_coding_standards()`

Purpose: - Retrieve the most relevant coding standards and architecture
rules for the changed code. - Support .NET, EF Core, Angular,
PostgreSQL, security, and general architecture categories. - Return the
rule text together with its document and section reference.

#### MCP Design Requirements

-   Tools must return compact, structured JSON.
-   Each tool must have a clear input schema and bounded output.
-   The server must expose only the data and operations required for
    code review.
-   The tools must not provide arbitrary shell execution or unrestricted
    repository write access.
-   Tool errors must be explicit and distinguish no-results from
    indexing or service failures.
-   The MCP server must be independently testable from Claude Code.

### 5.7 Claude Code Review Execution

-   The orchestrator must invoke Claude Code in headless mode.
-   The review prompt must include the PR metadata, focused diff, review
    objectives, and instructions for using MCP retrieval tools.
-   Claude Code must retrieve additional context on demand instead of
    receiving entire repositories or all standards by default.
-   The agent must distinguish confirmed issues from potential risks or
    recommendations.
-   The agent must provide evidence for findings, including file paths
    and line references wherever available.
-   The agent must avoid reporting a finding when supporting evidence is
    insufficient.
-   The review must be read-only. Claude Code must not modify source
    files, create commits, push branches, or merge pull requests.
-   Tool permissions must be explicitly restricted to the required MCP
    tools and other minimum necessary capabilities.
-   The orchestrator must capture execution status, duration, and
    relevant diagnostic information.

### 5.8 Review Output and Teams Delivery

The review result must be structured into categories such as:

1.  Integration mismatches.
2.  Potential reusability or duplication.
3.  Symbol impact and dependency risks.
4.  Coding-standard violations.
5.  Other actionable defects identified in the changed code.

Each finding should include, where applicable:

-   Severity.
-   Short title.
-   Description.
-   Evidence and reasoning.
-   Repository and file path.
-   Line reference.
-   Related backend/frontend symbol or standard.
-   Suggested action.

The system must format the result as a Microsoft Teams Adaptive Card and
post it as a reply to the originating thread.

If no actionable findings are identified, the response must clearly say
that no issues were identified by this review. It must not imply that
the PR is guaranteed to be defect-free.

------------------------------------------------------------------------

## 6. Non-Functional Requirements

### 6.1 Token Efficiency

The original target is approximately 2,000--4,000 tokens per review.

This should be treated as an initial optimization target, not a hard
correctness constraint. The system must not truncate essential evidence
or skip necessary retrieval merely to meet a token budget.

The orchestrator should record: - Input and output token usage, where
available. - Context supplied to Claude Code. - MCP tool calls and
returned payload sizes. - Review duration. - Model and execution
metadata available from the CLI.

### 6.2 Performance

The original target is a webhook-to-Teams response time of under 30
seconds.

This is a target to validate through a prototype and representative PR
benchmarks. Git checkout, indexing, queueing, and model response time
may make this target unrealistic for larger PRs.

The system should: - Reuse persistent repository indexes. - Perform
delta indexing rather than full indexing for each review. - Apply
timeouts to external operations. - Provide a clear status or failure
response when a review exceeds the target. - Support asynchronous
processing so the Teams webhook does not need to remain open for the
full review.

### 6.3 Reliability

-   Handle duplicate webhook deliveries idempotently.
-   Support retries for transient Git, database, Claude Code, and Teams
    failures.
-   Prevent concurrent reviews from corrupting shared worktrees or index
    state.
-   Record review lifecycle states.
-   Clean up temporary resources after success, failure, or
    cancellation.

### 6.4 Security and Data Isolation

-   Authenticate and validate incoming Teams requests.
-   Restrict repository access to configured repositories.
-   Store credentials and API keys securely; do not place secrets in
    prompts or logs.
-   Treat source code, PR descriptions, comments, and retrieved
    documents as untrusted input.
-   Defend against prompt injection embedded in repository content or
    documentation.
-   Keep Claude Code permissions restricted and read-only for review
    execution.
-   Redact secrets and sensitive values from logs and model context
    where feasible.
-   Isolate temporary review state by PR or review identifier.
-   Preserve audit records without retaining unnecessary sensitive
    content.

### 6.5 Observability

The system must provide structured logs and traceable identifiers for: -
Teams trigger. - Pull request. - Repository and commit revisions. -
Worktree lifecycle. - Indexing operations. - MCP calls. - Claude Code
execution. - Teams response delivery.

------------------------------------------------------------------------

## 7. Data Management and Index Lifecycle

### 7.1 Persistent Baseline Index

The main branch or configured baseline branch for each repository must
be indexed persistently. This avoids rebuilding the entire code index
for each review.

### 7.2 Pull Request Delta Index

For each review: - Identify changed files and symbols. - Parse and index
relevant changes. - Associate temporary or revision-specific records
with the PR review. - Ensure retrieval can distinguish baseline code
from PR changes.

### 7.3 Cleanup

-   Temporary worktrees must be removed after the review.
-   Temporary PR-specific index data must be removed or expired
    according to a defined retention policy.
-   Persistent baseline index records must not be deleted during PR
    cleanup.
-   Cleanup must be safe to retry and must run after failed reviews.

The initial PRD proposed immediate cleanup of ticket-scoped vector
entries. The final lifecycle should use a unique PR/review identifier
rather than only a ticket identifier, because multiple PRs can share a
ticket.

------------------------------------------------------------------------

## 8. Review Workflow

1.  A user mentions `@ReviewBot` in Teams and supplies a PR URL.
2.  The webhook validates the request and records the Teams thread
    reference.
3.  The orchestrator resolves PR metadata, repository, branches, and
    ticket identifier.
4.  The repository manager creates isolated worktrees.
5.  The orchestrator generates the focused Git diff.
6.  The code intelligence engine performs delta AST parsing and updates
    the relevant index.
7.  The orchestrator starts Claude Code in headless mode with the review
    prompt and restricted MCP access.
8.  Claude Code analyzes the diff and calls MCP tools when additional
    code or standards context is required.
9.  Claude Code returns structured review findings.
10. The orchestrator validates and formats the result.
11. The Teams adapter posts an Adaptive Card reply in the original
    thread.
12. The orchestrator records completion and cleans up temporary
    resources.

------------------------------------------------------------------------

## 9. Initial Acceptance Criteria

### Teams and Orchestration

-   A valid Teams PR request starts exactly one review.
-   The system resolves the primary repository and PR branches
    correctly.
-   Ticket-based companion branch matching works when a matching branch
    exists.
-   The configured baseline branch is used when no companion branch
    exists.
-   Duplicate webhook deliveries do not create duplicate active reviews.

### Code Intelligence

-   Initial indexing can identify the agreed .NET and Angular symbol
    types.
-   Delta indexing updates changed and deleted symbols correctly.
-   Retrieval returns repository, revision, file path, and source
    location.
-   Cross-repository integration tracing can identify a deliberately
    introduced API contract mismatch in a test fixture.

### Document RAG

-   Markdown documents can be ingested and indexed.
-   Modified documents are re-indexed without duplicating unchanged
    chunks.
-   Retrieval returns relevant rules with source document and heading
    information.
-   A test review retrieves the relevant Angular or .NET standard for a
    deliberately non-compliant code change.

### MCP and Claude Code

-   Claude Code can invoke all four MCP tools.
-   Tool responses are structured and bounded.
-   Claude Code can produce the agreed review output format.
-   The review process cannot modify, commit, push, or merge repository
    code.

### Teams Delivery and Operations

-   Review findings are posted to the correct Teams thread.
-   A no-findings review is clearly distinguished from a failed review.
-   Failures are logged with actionable diagnostic information.
-   Temporary worktrees and PR-specific data are cleaned up without
    deleting baseline index data.

------------------------------------------------------------------------

## 10. Suggested Implementation Phases

### Phase 1: Foundation

-   Set up the orchestrator.
-   Configure PostgreSQL and pgvector.
-   Implement repository configuration and Git worktree management.
-   Establish Claude Code headless execution.
-   Create the initial MCP server skeleton.

### Phase 2: Document RAG

-   Define the knowledge-base structure.
-   Implement Markdown discovery and ingestion.
-   Implement chunking and embedding generation.
-   Store and retrieve standards using pgvector.
-   Implement `get_coding_standards()`.

### Phase 3: Code Intelligence

-   Implement .NET and Angular AST parsing.
-   Create symbol and relationship schemas.
-   Implement persistent baseline indexing.
-   Implement incremental PR indexing.
-   Implement symbol and dependency retrieval.

### Phase 4: MCP Review Capabilities

-   Implement `trace_fe_be_integration()`.
-   Implement `trace_symbol_impact()`.
-   Implement `check_reusability()`.
-   Validate retrieval quality with representative repositories and test
    cases.

### Phase 5: Claude Code Review

-   Define the review prompt and structured output contract.
-   Configure restricted MCP tool permissions.
-   Implement headless execution and timeout handling.
-   Validate findings against known PR scenarios.

### Phase 6: Teams Integration and Hardening

-   Implement Teams webhook handling.
-   Implement Adaptive Card responses.
-   Add authentication, idempotency, retries, and concurrency controls.
-   Add observability and cleanup.
-   Benchmark token usage and end-to-end duration.

------------------------------------------------------------------------

## 11. Risks and Open Decisions

The following items must be resolved during technical design and
prototyping:

1.  **Embedding model and dimensions:** Select the embedding model and
    ensure its output dimension matches the pgvector schema.
2.  **AST parser technology:** Confirm suitable parsers and
    language-version support for the Angular/TypeScript and .NET
    codebases.
3.  **Dependency graph construction:** Define which relationships can be
    extracted reliably and how incomplete relationships are represented.
4.  **Branch and revision strategy:** Finalize baseline indexing and
    PR-specific index isolation.
5.  **Teams integration method:** Confirm the supported Teams bot or
    webhook mechanism, authentication, and Adaptive Card capabilities.
6.  **Claude Code execution environment:** Confirm CLI installation,
    authentication, supported headless options, and safe permission
    configuration.
7.  **Performance targets:** Benchmark representative pull requests
    before committing to the 30-second target.
8.  **Token budget:** Measure actual context and token usage before
    enforcing a review budget.
9.  **Knowledge ownership:** Define who maintains coding standards and
    approves changes to the knowledge base.
10. **Retention:** Define retention periods for review logs, PR-specific
    index records, and diagnostic data.

------------------------------------------------------------------------

## 12. Success Metrics

The initial release should be evaluated using:

-   Percentage of valid Teams requests that complete successfully.
-   Accuracy of repository and companion-branch resolution.
-   Precision of reported integration mismatches.
-   Relevance of retrieved coding standards.
-   Precision of actionable code review findings.
-   Percentage of findings with usable source evidence.
-   Average and percentile review duration.
-   Average input/output token usage per review.
-   MCP retrieval latency and result size.
-   Failure and retry rates.

Success should be measured against a representative set of real or
controlled pull requests, including known defects and intentional
standards violations.

------------------------------------------------------------------------

## 13. Final Architecture Decision Summary

  -----------------------------------------------------------------------
  Area                                Initial decision
  ----------------------------------- -----------------------------------
  Review agent                        Claude Code

  Execution mode                      Headless CLI (`claude -p`)

  Orchestrator                        Node.js or Python; finalize in TDD

  Trigger                             Microsoft Teams

  Backend/frontend scope              .NET and Angular

  Code intelligence                   AST parsing, symbol indexing,
                                      dependency relationships

  Document knowledge                  Markdown-based RAG

  Vector storage                      PostgreSQL + pgvector

  Agent integration                   Local MCP server

  Review output                       Structured findings in Teams
                                      Adaptive Cards

  Model strategy                      Claude Code only for initial
                                      release

  Local inference                     Out of scope for initial release

  Repository changes                  Read-only review; no automatic
                                      fixes or merges
  -----------------------------------------------------------------------

**Architecture principle:** Claude Code is the review agent; the
orchestrator manages the workflow; MCP exposes controlled capabilities;
Code Intelligence understands the repositories; and Document RAG
supplies the engineering knowledge needed to review them consistently.
