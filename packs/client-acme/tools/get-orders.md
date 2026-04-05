---
name: acme_get_orders
description: "Pull recent orders from ACME Corp's Shopify store. Returns order ID, customer name, items, total, and fulfillment status."
type: declarative_http
parameters:
  - name: status
    type: string
    description: "Filter by status: open, closed, any (default: open)"
    required: false
  - name: limit
    type: number
    description: "Max orders to return (default: 10, max: 50)"
    required: false
endpoint:
  method: GET
  url: "https://acme-demo.myshopify.com/admin/api/2024-01/orders.json"
  headers:
    X-Shopify-Access-Token: "${CLIENT_ACME_SHOPIFY_TOKEN}"
    Content-Type: "application/json"
  query:
    status: "${status}"
    limit: "${limit}"
  response_path: "orders"
---
