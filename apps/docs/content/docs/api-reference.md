---
title: API Reference
excerpt: Reference guides, package registries, source entrypoints, and public event contracts.
section: Reference
sectionOrder: 5
order: 1
---

# API Reference

The public repository is the source of truth for package behavior. Each reference guide below describes the supported public surface and links directly to its implementation.

## Reference guides

| Guide                                          | Covers                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [TypeScript API](/docs/typescript-reference)   | `@traice/sdk` functions, classes, adapters, integrations, analytics, guardrails, and exported types |
| [Python API](/docs/python-reference)           | `traice-sdk` functions, client lifecycle, tracker, callback handler, and public data classes        |
| [Event contracts](/docs/event-reference)       | Product transport fields, SDK-local events, internal usage events, and `@traice/protocol` utilities |
| [Collector overview](/docs/collector-overview) | `@traice/collector` CLI workflows, configuration, adapters, credentials, and service lifecycle      |

## Packages and source

| Package             | Registry                                               | Public entrypoint                                                                                                                    | Package docs                                                                             | Changelog                                                                                      |
| ------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `@traice/sdk`       | [npm](https://www.npmjs.com/package/@traice/sdk)       | [`packages/sdk/src/index.ts`](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/index.ts)                           | [README](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/README.md)       | [CHANGELOG](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/CHANGELOG.md)       |
| `traice-sdk`        | [PyPI](https://pypi.org/project/traice-sdk/)           | [`packages/python/src/traice/__init__.py`](https://github.com/runtraice/traice-sdk/blob/main/packages/python/src/traice/__init__.py) | [README](https://github.com/runtraice/traice-sdk/blob/main/packages/python/README.md)    | [CHANGELOG](https://github.com/runtraice/traice-sdk/blob/main/packages/python/CHANGELOG.md)    |
| `@traice/collector` | [npm](https://www.npmjs.com/package/@traice/collector) | [`packages/collector/src/index.ts`](https://github.com/runtraice/traice-sdk/blob/main/packages/collector/src/index.ts)               | [README](https://github.com/runtraice/traice-sdk/blob/main/packages/collector/README.md) | [CHANGELOG](https://github.com/runtraice/traice-sdk/blob/main/packages/collector/CHANGELOG.md) |
| `@traice/protocol`  | [npm](https://www.npmjs.com/package/@traice/protocol)  | [`packages/protocol/src/index.ts`](https://github.com/runtraice/traice-sdk/blob/main/packages/protocol/src/index.ts)                 | [README](https://github.com/runtraice/traice-sdk/blob/main/packages/protocol/README.md)  | [CHANGELOG](https://github.com/runtraice/traice-sdk/blob/main/packages/protocol/CHANGELOG.md)  |

## Import names

The npm packages keep the `@traice` organization scope. Python package indexes do not support npm-style scopes, so the Python distribution is named `traice-sdk` and its import name is `traice`.

```text
npm install @traice/sdk
pip install traice-sdk
```

All currently supported TypeScript SDK exports come from the package root. Python users can import the documented root symbols from `traice`; `TraiceCallbackHandler` is also available from `traice.integrations`.

## Version and support policy

Use the registry changelog and the package source from the same released version when exact behavior matters. Main-branch source can include changes that have not reached a registry yet.

The API reference documents public entrypoint exports. Internal helpers that are exported from implementation files but not re-exported by a package entrypoint are not supported as package APIs.

Report package defects in [GitHub Issues](https://github.com/runtraice/traice-sdk/issues). Include the package name, installed version, runtime version, minimal reproduction, and sanitized error output.
