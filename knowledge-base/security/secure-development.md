# Secure Development

## Secrets

Never commit API keys, access tokens, or connection credentials. Load secrets from the deployment environment and avoid logging them.

## Input validation

Treat repository content and external service responses as untrusted input and validate them before use.
