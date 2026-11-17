# System Architecture

## Service boundaries

Keep review orchestration separate from repository access, knowledge retrieval, and model invocation. Cross-boundary calls should use explicit typed contracts.

## Failure handling

Record actionable failure states without discarding metadata already gathered during the review.
