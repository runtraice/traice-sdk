---
title: Introduction
excerpt: Public packages for product LLM attribution and coding-agent spend collection.
order: 1
---

# Introduction

The public trAIce repository contains three packages:

- `@traice/sdk` for product-runtime LLM cost attribution.
- `@traice/collector` for local coding-agent telemetry collection.
- `@traice/protocol` for shared event types and normalization helpers.

Product events and internal coding-agent usage are separate data streams. Product events are sent to `/api/v1/events`. Collector rows are sent to `/api/v1/internal-usage`.

The public repo is curated from an allowlist. SaaS application code, environment files, database schemas, migrations, customer data, and deployment configuration do not belong here.
