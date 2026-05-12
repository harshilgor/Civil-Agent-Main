/**
 * Auto-detect known inputs from the user's first message text.
 * Returns a partial knownInputs object.
 */

const DETECTION_RULES = [
  { pattern: /\bsteel\b/i,                                  key: "structural_system", value: "Steel" },
  { pattern: /\bconcrete\b/i,                                key: "structural_system", value: "Concrete" },
  { pattern: /\b(wood|timber)\b/i,                           key: "structural_system", value: "Wood" },
  { pattern: /\bhybrid\b/i,                                  key: "structural_system", value: "Hybrid" },
  { pattern: /\boffice\b/i,                                  key: "building_use",      value: "Office" },
  { pattern: /\b(residential|apartment)\b/i,                 key: "building_use",      value: "Residential" },
  { pattern: /\bmixed[\s-]?use\b/i,                          key: "building_use",      value: "Mixed-use" },
  { pattern: /\b(parking|garage)\b/i,                        key: "building_use",      value: "Parking" },
  { pattern: /\bindustrial\b/i,                              key: "building_use",      value: "Industrial" },
  { pattern: /\bschool\b/i,                                  key: "building_use",      value: "School/Institutional" },
  { pattern: /\bcost\b/i,                                    key: "optimization_goal", value: "Lowest cost" },
  { pattern: /\bdrift\b/i,                                   key: "optimization_goal", value: "Lowest drift" },
  { pattern: /\b(tonnage|weight)\b/i,                        key: "optimization_goal", value: "Lowest tonnage" },
];

const LOCATION_PATTERN = /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)*),?\s*([A-Z]{2})\b/;

export function autoDetectInputs(messageText) {
  const inputs = {};
  const text = messageText || "";

  for (const rule of DETECTION_RULES) {
    if (rule.pattern.test(text) && !inputs[rule.key]) {
      inputs[rule.key] = rule.value;
    }
  }

  const locationMatch = text.match(LOCATION_PATTERN);
  if (locationMatch) {
    inputs.project_location = `${locationMatch[1]}, ${locationMatch[2]}`;
  }

  return inputs;
}
