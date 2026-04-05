---
name: acme_post_shipment
description: "Post shipment tracking information back to ACME Corp's Shopify order. Creates a fulfillment with tracking number and carrier."
type: declarative_http
parameters:
  - name: order_id
    type: string
    description: "Shopify order ID to fulfill"
    required: true
  - name: tracking_number
    type: string
    description: "Carrier tracking number"
    required: true
  - name: tracking_company
    type: string
    description: "Shipping carrier (e.g., UPS, FedEx, USPS, DHL)"
    required: true
endpoint:
  method: POST
  url: "https://acme-demo.myshopify.com/admin/api/2024-01/orders/${order_id}/fulfillments.json"
  headers:
    X-Shopify-Access-Token: "${CLIENT_ACME_SHOPIFY_TOKEN}"
    Content-Type: "application/json"
  body:
    fulfillment:
      tracking_number: "${tracking_number}"
      tracking_company: "${tracking_company}"
      notify_customer: true
---
