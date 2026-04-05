# ACME Corp Integration Pack

**Type:** Sample client integration (SaaS revenue model proof of concept)
**Level:** 2 (declarative HTTP tools + generated code)

## What This Demonstrates

This pack shows how clauded integrates with a client's systems to generate recurring revenue:

1. **Order ingestion:** Pull orders from the client's Shopify store
2. **Status tracking:** Check fulfillment progress per order
3. **Shipment updates:** Post tracking info back to Shopify (customer gets notified)
4. **Reporting:** Generate order summary with revenue and fulfillment breakdown

## Revenue Model

| Activity | Billable? | How |
|----------|-----------|-----|
| Order pull (daily/on-demand) | Included in Standard tier | Automated via scheduled task |
| Status checks | Included | On-demand via conversation |
| Shipment posting | Included | Conversational — user provides tracking |
| Custom reports | Premium tier | AI generates from order data |
| Custom automation | Professional services | New tools/skills added to pack |

## Setup

1. Get Shopify API access token from client
2. Add to `.env`: `CLIENT_ACME_SHOPIFY_TOKEN=shpat_xxxxx`
3. Enable pack: `/pack enable client-acme`

## Tools

| Tool | Type | Description |
|------|------|-------------|
| `acme_get_orders` | Declarative HTTP | Pull orders from Shopify |
| `acme_order_status` | Declarative HTTP | Check specific order status |
| `acme_post_shipment` | Declarative HTTP | Post fulfillment + tracking |
| `acme_order_summary` | Generated code | Summarize orders (count, revenue, status) |

## Skill

**acme-coordinator** — AI persona that knows ACME's products, contacts, order patterns, and shipping preferences. Auto-activates when user mentions "ACME".

## Replicating for New Clients

To create a similar pack for a new client:
1. Copy this pack: `cp -r packs/client-acme packs/client-newcorp`
2. Update `pack.yaml` with new client name and API endpoints
3. Update tool definitions with new API URLs and tokens
4. Update skill persona with client-specific knowledge
5. Add API token to `.env`

Or use the conversational builder: "I need a client integration pack for NewCorp's Shopify store"
