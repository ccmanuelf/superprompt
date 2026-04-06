---
name: hub_bom_lookup
description: "Look up Bill of Materials for a finished goods part number. Returns component list with quantities and availability."
type: generated_code
parameters:
  - name: part_number
    type: string
    description: "Finished goods part number (e.g., FG-7710-BLU)"
    required: true
---
```javascript
// Sample BOM data — will be replaced with real BOM API connection
const sampleBOMs = {
  'FG-7710-BLU': {
    description: 'Blue Cotton Shirt - Standard',
    revision: 'Rev C',
    components: [
      { part: 'RM-4471-BLU', desc: 'Blue Cotton Twill 60"', qty_per: 1.5, uom: 'yd', on_hand: 450, required: 750, status: 'short' },
      { part: 'RM-2201-WHT', desc: 'White Thread 5000yd', qty_per: 0.02, uom: 'spool', on_hand: 50, required: 10, status: 'ok' },
      { part: 'RM-3310-MET', desc: 'Metal Buttons 15mm', qty_per: 6, uom: 'ea', on_hand: 5000, required: 3000, status: 'ok' },
      { part: 'PK-1001-STD', desc: 'Standard Poly Bag', qty_per: 1, uom: 'ea', on_hand: 2000, required: 500, status: 'ok' },
      { part: 'LB-0050-BLU', desc: 'Care Label - Blue', qty_per: 1, uom: 'ea', on_hand: 100, required: 500, status: 'short' },
    ],
  },
};
const bom = sampleBOMs[args.part_number];
if (!bom) {
  return {
    error_en: 'BOM not found for ' + args.part_number + '. Check part number or contact engineering.',
    error_es: 'BOM no encontrado para ' + args.part_number + '. Verifica el numero de parte o contacta a ingenieria.',
  };
}
const shortages = bom.components.filter(c => c.status === 'short');
return {
  part_number: args.part_number,
  description: bom.description,
  revision: bom.revision,
  total_components: bom.components.length,
  components: bom.components,
  shortages: shortages.length,
  shortage_items: shortages.map(s => s.part + ' (' + s.desc + '): need ' + s.required + ', have ' + s.on_hand),
  message_en: 'BOM for ' + args.part_number + ' (' + bom.description + ', ' + bom.revision + '): ' + bom.components.length + ' components. ' + (shortages.length > 0 ? shortages.length + ' shortage(s) detected.' : 'All materials available.'),
  message_es: 'BOM para ' + args.part_number + ' (' + bom.description + ', ' + bom.revision + '): ' + bom.components.length + ' componentes. ' + (shortages.length > 0 ? shortages.length + ' faltante(s) detectado(s).' : 'Todos los materiales disponibles.'),
};
```
