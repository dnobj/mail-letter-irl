# Documentation Standards

**Last Updated:** December 17, 2025
**Purpose:** Codify documentation conventions and best practices for Letter IRL

---

## Overview

This document defines the documentation standards for Letter IRL. These conventions emerged organically during development and have proven effective for maintaining clarity, consistency, and navigability across the project.

**Philosophy:**
- Documentation should serve developers, not burden them
- Consistency aids navigation and understanding
- Semantic naming prevents merge conflicts
- Clear structure makes information findable

---

## File Naming Conventions

### Semantic Over Sequential

Use descriptive semantic names rather than sequential numbers to avoid merge conflicts and improve clarity.

**Pattern:** `PREFIX-descriptive-name.md`

**Examples:**
```
GOOD:
- user-stories.md
- letter-send-flow.md
- database-schema.md
- mcp-authentication.md

AVOID:
- DOC-001.md
- SPEC-002.md
- REQ-003.md
```

### Naming Patterns by Document Type

All documentation files should use **lowercase-with-hyphens.md** format for consistency and to avoid case-sensitivity issues across different operating systems.

| Type | Pattern | Examples |
|------|---------|----------|
| **Core Specs** | lowercase-with-hyphens.md | status.md, deployment.md, testing.md |
| **Guides** | lowercase-with-hyphens.md | admin-panel-guide.md, database-setup.md |
| **Implementation Docs** | lowercase-implementation.md | acp-implementation-guide.md, credit-api-implementation.md |
| **Feature Specs** | lowercase-feature-spec.md | credit-packages-spec.md |
| **Flows** | lowercase-flow.md | credit-purchase-flow.md, user-flows.md |

### Naming Convention

- **All files** use lowercase-with-hyphens for consistency
- Hyphens separate words for readability
- No underscores or camelCase in filenames
- Consistent naming prevents cross-platform compatibility issues

---

## Document Structure

### Standard Header

Every document should start with a standard header:

```markdown
# Document Title

**Last Updated:** YYYY-MM-DD
**Purpose:** Brief one-line description of document's purpose

---

## Overview

[Brief summary - what is this document about and who is it for?]
```

**Key fields:**
- `Last Updated` - Use format `Month DD, YYYY` (e.g., "December 17, 2025") or `YYYY-MM-DD`
- `Purpose` - Single sentence describing the document's role
- `Status` (optional) - For plans/specs: Draft, Active, Deprecated, Superseded

### Content Organization

Use clear hierarchical sections:

```markdown
## Main Section
[Context and overview]

### Subsection
[Specific content]

#### Detail Level (use sparingly)
[Implementation details]
```

**Guidelines:**
- Use `##` for major sections
- Use `###` for subsections
- Avoid going deeper than `####` (indicates content needs restructuring)
- Start each major section with brief context before diving into details

### Code Examples

Use language-specific code fences with clear labels:

```markdown
**Request:**
```json
{
  "example": "value"
}
```

**Response:**
```typescript
interface Example {
  field: string;
}
```
```

**Best practices:**
- Always specify language for syntax highlighting
- Include context labels (Request/Response, Before/After, etc.)
- Keep examples concise and focused on the point being illustrated

### Tables

Use tables for structured comparisons and reference data:

```markdown
| Column 1 | Column 2 | Column 3 |
|----------|----------|----------|
| Value A  | Value B  | Value C  |
```

**When to use tables:**
- Comparing options or alternatives
- Reference lists (environment variables, endpoints, status codes)
- Field definitions
- Mapping tables (e.g., status mappings, persona-story matrix)

---

## Document Types and Templates

### 1. Feature Specifications

**Naming:** `feature-name-spec.md` or `FEATURE-NAME.md`

**Template:**
```markdown
# Feature Name

**Last Updated:** YYYY-MM-DD
**Status:** Draft | Active | Deprecated
**Purpose:** What this feature does and why it exists

---

## Overview
[What is this feature?]

## Requirements
[What must this feature do?]

## Design
[How does it work?]

## Implementation
[Technical details]

## Testing
[How to verify it works]

## Related Documents
- [Link to related doc]
```

**Examples:** `credit-packages-spec.md`, `image-support.md`

### 2. Implementation Guides

**Naming:** `feature-implementation-guide.md`

**Template:**
```markdown
# Feature Implementation Guide

**Last Updated:** YYYY-MM-DD
**Purpose:** Step-by-step guide for implementing [feature]

---

## Overview
[What you'll build]

## Prerequisites
[What you need before starting]

## Step 1: [Task Name]
[Instructions]

## Step 2: [Task Name]
[Instructions]

## Verification
[How to test it works]

## Troubleshooting
[Common issues and solutions]
```

**Examples:** `acp-implementation-guide.md`, `database-setup.md`

### 3. Flow Documentation

**Naming:** `feature-flow.md` or `FEATURE-FLOW.md`

**Template:**
```markdown
# Feature Flow

**Last Updated:** YYYY-MM-DD
**Purpose:** Detailed walkthrough of [feature] execution

---

## Overview
[What happens in this flow]

## Flow Diagram
```
[ASCII diagram or steps]
```

## Step-by-Step
### Step 1: [Action]
[Details]

### Step 2: [Action]
[Details]

## Error Handling
[What happens when things go wrong]

## Related Documents
- [Link to implementation]
```

**Examples:** `letter-send-flow.md`, `user-flows.md`, `credit-purchase-flow.md`

### 4. Learnings Documents

**Location:** `docs/learnings/`

**Naming:** `topic-learnings.md` or `technology-context-learnings.md`

**Template:**
```markdown
# Topic Learnings

**Created:** YYYY-MM-DD
**Status:** Validated and working | In progress | Deprecated
**Related:** [Related features/technologies]

---

## Overview
[What was learned and why it matters]

## Key Finding: [Discovery Name]
[The most important discovery]

### Why This Matters
[Impact and implications]

### What We Tried
[Approaches attempted]

### What Worked
[The solution]

## Common Issues and Solutions
### Issue 1: [Problem]
**Cause:** [Why it happens]
**Solution:** [How to fix it]

## References
- [External links]
```

**Examples:** `learnings/claude-desktop-mcp.md`, `learnings/chatgpt-auth0-oauth-learnings.md`

### 5. Status and Overview Documents

**Naming:** `status.md`, `index.md`, `overview.md`

**Template:**
```markdown
# Project Name - Status

**Last Updated:** YYYY-MM-DD
**Current Phase:** [Development stage]
**Overall Progress:** [Percentage or milestone]

---

## Project Overview
[What this project does]

## What's Complete
- [x] Feature A
- [x] Feature B

## In Progress
- [ ] Feature C

## Known Issues / Future Work
[Things to address]

## Documentation Index
[Links to all major docs]
```

**Examples:** `status.md`, `index.md`

---

## Metadata and Cross-References

### Related Documents Section

Every document should end with links to related documents:

```markdown
## See Also

- [DOCUMENT-NAME.md](DOCUMENT-NAME.md) - Brief description
- [Other-Doc.md](Other-Doc.md) - Brief description
```

**Purpose:**
- Helps readers find related information
- Creates a knowledge graph of documentation
- Prevents orphaned documents

### Changelog (for living documents)

For documents that undergo frequent updates, include a changelog:

```markdown
## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2025-12-17 | Name | Updated authentication flow |
| 2025-12-10 | Name | Initial version |
```

**When to use:**
- Documents updated by multiple people
- Critical specs that change over time
- When tracking decision evolution is important

---

## Content Guidelines

### Writing Style

**Be Clear and Direct:**
- Write in active voice
- Use present tense for current state
- Use "we" for team decisions, "you" for instructions
- Avoid jargon unless necessary (and define it when used)

**Example:**
```markdown
GOOD: "The system validates addresses via PostGrid before sending."
AVOID: "Address validation will be performed by the system using PostGrid."

GOOD: "Run `npm run dev` to start the development server."
AVOID: "The development server can be started by running npm run dev."
```

### Date Formats

Use consistent date formats:

- **Full dates:** `December 17, 2025` (in headers/narrative)
- **ISO dates:** `2025-12-17` (in tables/changelogs/timestamps)

**Examples:**
```markdown
**Last Updated:** December 17, 2025
**Created:** 2025-12-17

| Date | Event |
|------|-------|
| 2025-12-17 | Feature launched |
```

### Status Values

Use consistent status terminology:

**For Documents:**
- `Draft` - Work in progress
- `Active` - Current and maintained
- `Deprecated` - Obsolete but kept for reference
- `Superseded` - Replaced by another document (link to replacement)

**For Features:**
- `Planned` - Not yet started
- `In Progress` - Currently being implemented
- `Complete` - Implemented and working
- `Deprecated` - No longer maintained

### User Story Prefixes

For user stories, use semantic prefixes to organize by feature area:

| Prefix | Area | Examples |
|--------|------|----------|
| `US-LETTER` | Letter Sending | US-LETTER-01, US-LETTER-02 |
| `US-CREDIT` | Credits | US-CREDIT-01, US-CREDIT-02 |
| `US-PROMO` | Promo Codes | US-PROMO-01, US-PROMO-02 |
| `US-ACCT` | Account | US-ACCT-01, US-ACCT-02 |
| `US-ADMIN` | Admin | US-ADMIN-01, US-ADMIN-02 |
| `US-EDGE` | Edge Cases | US-EDGE-01, US-EDGE-02 |
| `US-SEC` | Security | US-SEC-01, US-SEC-02 |
| `US-DATA` | Data Integrity | US-DATA-01, US-DATA-02 |
| `US-MCP` | MCP Access | US-MCP-01, US-MCP-02 |

**Benefits:**
- Stories naturally group by feature area
- No merge conflicts from sequential numbering
- Clear category at a glance
- Easy to reference in commit messages and PRs

---

## Directory Structure

```
docs/
├── standards.md              # This file
├── index.md                  # Documentation index (start here)
├── status.md                 # Project status overview
├── README.md                 # External-facing intro (if needed)
│
├── Core Documentation
├── deployment.md
├── database-schema.md
├── testing.md
├── personas.md
├── user-stories.md
│
├── Guides
├── admin-panel-guide.md
├── database-setup.md
├── account-switching-guide.md
│
├── Implementation Docs
├── acp-implementation-guide.md
├── credit-api-implementation.md
├── job-queue-implementation.md
│
├── Specs and Plans
├── credit-packages-spec.md
├── engineering-plan.md
├── oauth-plan.md
│
├── learnings/                # Post-mortems and insights
│   ├── claude-desktop-mcp.md
│   ├── chatgpt-auth0-oauth-learnings.md
│   └── app-integration-learnings.md
│
└── archive/                  # Obsolete documents
    ├── dashboard-implementation.md
    └── old-spec.md
```

### When to Create a Subdirectory

Create subdirectories when:
- You have 5+ related documents (e.g., `learnings/`)
- Documents form a logical category distinct from main docs
- You want to preserve obsolete docs without cluttering main directory (`archive/`)

**Don't create subdirectories:**
- For single documents
- For unclear categorization (keep in root)
- Just for organization's sake (flat is often better)

---

## When to Create New Documentation

### Create New Documents For:

1. **New Features** - Implementation guides, specs, flows
2. **Architectural Decisions** - Why you chose a specific approach
3. **Integration Guides** - How to set up external services
4. **Learnings** - Key discoveries, gotchas, debugging insights
5. **User-Facing Changes** - New MCP tools, API endpoints

### Update Existing Documents For:

1. **Bug Fixes** - Update troubleshooting sections
2. **Configuration Changes** - Update environment variables, settings
3. **Flow Modifications** - Update diagrams and step-by-step guides
4. **Status Changes** - Update status.md with progress

### Don't Create Documents For:

1. **Code Comments** - Belongs in source code
2. **TODOs** - Use issue tracker or code comments
3. **Personal Notes** - Keep in private notes, not committed docs
4. **Duplicated Information** - Link to existing doc instead

---

## Archiving and Deprecation

### When to Archive

Move documents to `docs/archive/` when:
- Feature has been removed or replaced
- Document is no longer accurate and won't be updated
- Historical context is valuable but shouldn't clutter main docs

### How to Archive

1. Move file to `docs/archive/`
2. Add deprecation notice at top of document:
   ```markdown
   > **DEPRECATED:** This document is archived and no longer maintained.
   > See [NEW-DOC.md](../NEW-DOC.md) for current information.
   ```
3. Update any links pointing to the document
4. Update `index.md` to reflect archive status

### Never Delete

Don't delete documentation. Archive it instead. Reasons:
- Preserves project history
- Useful for understanding past decisions
- May contain valuable insights for future work
- Git history isn't always easy to browse

---

## Maintenance

### Periodic Reviews

Review documentation quarterly (or after major releases):

1. **Currency Check** - Are docs still accurate?
2. **Link Validation** - Do all cross-references work?
3. **Completion Check** - Are in-progress docs finished or stale?
4. **Archive Check** - Should any docs be archived?

### Ownership

- **Everyone maintains docs** - If you change code, update related docs
- **Librarian Agent** - Can help with large-scale doc updates and organization
- **Project Lead** - Final authority on standards and disputes

### Quality Checklist

Before committing new documentation:

- [ ] Follows naming convention for document type
- [ ] Includes standard header with Last Updated and Purpose
- [ ] Has clear Overview section
- [ ] Uses consistent formatting (headings, code blocks, tables)
- [ ] Includes Related Documents section
- [ ] Linked from `index.md` (if major document)
- [ ] Spellchecked and proofread
- [ ] Code examples tested and working
- [ ] No broken internal links

---

## Markdown Conventions

### Headings

- Use ATX-style headings (`#`, `##`, `###`) not Setext-style (`===`, `---`)
- Single space after `#` symbols: `## Heading` not `##Heading`
- Leave blank lines before and after headings

### Lists

- Use `-` for unordered lists (not `*` or `+`)
- Use `1.` for ordered lists (Markdown auto-numbers)
- Indent nested lists with 2 spaces
- Leave blank line after list before next paragraph

### Links

- Use descriptive link text: `[setup guide](setup.md)` not `[click here](setup.md)`
- Use relative paths for internal links: `[doc](../other-doc.md)` not `[doc](/full/path)`
- Include file extension: `[guide](guide.md)` not `[guide](guide)`

### Emphasis

- Use `**bold**` for strong emphasis
- Use `*italic*` for light emphasis
- Use `` `code` `` for inline code/commands
- Use `> blockquote` for important callouts

### Horizontal Rules

Use `---` for section breaks (three hyphens)

---

## Examples of Good Documentation

**Exemplary docs in this project:**
- `user-stories.md` - Clear structure, semantic prefixes, comprehensive coverage
- `personas.md` - Good use of tables, clear categories, well-linked to user stories
- `status.md` - Concise overview, up-to-date status, good starting point
- `learnings/claude-desktop-mcp.md` - Captures key insights, troubleshooting, and working solutions
- `letter-send-flow.md` - Clear flow documentation with diagrams

**What makes them good:**
- Start with clear overview
- Use consistent structure
- Include practical examples
- Link to related documentation
- Regularly updated
- Easy to scan (good use of headings, tables, lists)

---

## Tools and Automation

### Recommended Tools

- **Markdown linter:** [markdownlint](https://github.com/DavidAnson/markdownlint) for consistency
- **Link checker:** [markdown-link-check](https://github.com/tcort/markdown-link-check) for broken links
- **Spell checker:** Built-in IDE spell checker or [cspell](https://github.com/streetsidesoftware/cspell)

### Pre-commit Hooks (Optional)

Consider adding pre-commit hooks to enforce standards:

```bash
# .husky/pre-commit
npx markdownlint 'docs/**/*.md'
npx markdown-link-check docs/**/*.md
```

---

## Getting Help

### For Documentation Questions

1. Check this standards.md file
2. Look at exemplary documents for patterns
3. Ask in team chat or PR comments
4. Use Librarian Agent for large-scale doc work

### For Content Questions

1. Check `index.md` for document map
2. Use file search in your editor
3. Check `status.md` for current project state
4. Look in `learnings/` for implementation insights

---

## Changelog

| Date | Change |
|------|--------|
| 2025-12-17 | Standardized all filenames to lowercase-with-hyphens |
| 2025-12-17 | Initial standards document based on observed patterns |

---

## See Also

- [index.md](index.md) - Documentation index and navigation
- [status.md](status.md) - Current project status
- [user-stories.md](user-stories.md) - Example of user story semantic prefixes
- [personas.md](personas.md) - Example of well-structured reference documentation
