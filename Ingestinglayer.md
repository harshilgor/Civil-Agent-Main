Civil Agent Input Layer

1. IFC Adapter
   Tool: IfcOpenShell
   Best for: .ifc files
   Output: semantic BIM geometry JSON

2. Revit Adapter
   Tool: Revit API / APS / cad2data
   Best for: .rvt files
   Output: model elements + properties + geometry

3. DWG Adapter
   Tool: APS / ezdxf / ODA-based converter / cad2data
   Best for: .dwg drawings
   Output: layers, lines, blocks, text, dimensions

4. PDF/Image Adapter
   Tool: CV + OCR
   Best for: scanned/exported floor plans
   Output: inferred wall graph, rooms, dimensions, labels

5. Manual JSON Adapter
   Tool: internal test files
   Best for: debugging Agent 2/3
   Output: controlled schema