---
name: acme_order_status
description: "Check fulfillment status of a specific ACME Corp order by order number."
type: declarative_http
parameters:
  - name: order_id
    type: string
    description: "Shopify order ID or order number"
    required: true
endpoint:
  method: GET
  url: "https://acme-demo.myshopify.com/admin/api/2024-01/orders/${order_id}.json"
  headers:
    X-Shopify-Access-Token: "${CLIENT_ACME_SHOPIFY_TOKEN}"
    Content-Type: "application/json"
  response_path: "order"
---
