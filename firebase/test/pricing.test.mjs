import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeQuote } from "../web/js/pricing.mjs";

const EQUIPMENT_TYPES = {
  "EQP-TREAD": { deliveryMinutes: 20, pickupMinutes: 20, defaultCrewSize: 2, defaultAssemblyCharge: 50, defaultDisposalCharge: 50 },
  "EQP-ELLIP": { deliveryMinutes: 20, pickupMinutes: 20, defaultCrewSize: 2, defaultAssemblyCharge: 50, defaultDisposalCharge: 50 },
};
const ACCESS_CONDITIONS = {
  "ACC-GARAGE": { defaultMinutes: 0, flatCharge: 0 },
  "ACC-STAIR1": { defaultMinutes: 20, flatCharge: 20 },
};
const SETTINGS = {
  laborRatePerEmployeeHour: 25,
  vehicleRatePerMile: 0.85,
  baseTripCharge: 30,
  minimumServiceCharge: 30,
  priceRoundingIncrement: 5,
  usedItemDeliveryCharge: 20,
  tradeInPickupDiscount: 15,
};

test("matches imported job GP-2026-0001 exactly", () => {
  const r = computeQuote({
    equipment: [{ equipmentTypeId: "EQP-TREAD", condition: "new", quantity: 1, deliveryRequired: true }],
    access: ["ACC-GARAGE"],
    route: { roundTripMiles: 1.23, outboundMinutes: 4, returnMinutes: 3 },
    pickupType: null,
    equipmentTypes: EQUIPMENT_TYPES,
    accessConditions: ACCESS_CONDITIONS,
    settings: SETTINGS,
  });
  assert.equal(r.finalTotal, 105);
  assert.equal(r.durationMinutes, 27);
  assert.equal(r.crewSize, 2);
  assert.equal(r.hasBuildItems, true);
  assert.equal(r.pricing.mileageCharge, 1.05);
  assert.equal(r.pricing.travelLaborCharge, 22.5);
  assert.equal(r.pricing.assemblyCharge, 50);
  assert.equal(r.pricing.calculatedSubtotal, 103.55);
});

test("used delivery with one flight of stairs", () => {
  const r = computeQuote({
    equipment: [{ equipmentTypeId: "EQP-ELLIP", condition: "used", quantity: 1, deliveryRequired: true }],
    access: [{ accessConditionId: "ACC-STAIR1", quantity: 1 }],
    route: { roundTripMiles: 16, outboundMinutes: 15, returnMinutes: 15 },
    pickupType: null,
    equipmentTypes: EQUIPMENT_TYPES,
    accessConditions: ACCESS_CONDITIONS,
    settings: SETTINGS,
  });
  // base 30 + mileage 13.6 + travelLabor ((30+20+20)/60*2*25=58.33) + usedDelivery 20 + stairs flat 20
  assert.equal(r.pricing.usedItemDeliveryCharge, 20);
  assert.equal(r.pricing.accessLaborCharge, 20);
  assert.equal(r.pricing.mileageCharge, 13.6);
  assert.equal(r.durationMinutes, 70);
  assert.equal(r.finalTotal, 140); // 141.93 -> nearest 5
});

test("trade-in pickup applies the discount once", () => {
  const r = computeQuote({
    equipment: [{ equipmentTypeId: "EQP-ELLIP", condition: "used", quantity: 1, deliveryRequired: false, pickupRequired: true }],
    access: [],
    route: { roundTripMiles: 10, outboundMinutes: 10, returnMinutes: 10 },
    pickupType: "trade-in",
    equipmentTypes: EQUIPMENT_TYPES,
    accessConditions: ACCESS_CONDITIONS,
    settings: SETTINGS,
  });
  assert.equal(r.pricing.tradeInPickupDiscount, 15);
  assert.equal(r.pricing.usedItemDeliveryCharge, 0); // pickup-only, no delivery charge
});

test("minimum service charge floors a tiny job", () => {
  const r = computeQuote({
    equipment: [{ equipmentTypeId: "EQP-TREAD", condition: "new", quantity: 1, deliveryRequired: true }],
    access: [],
    route: { roundTripMiles: 0, outboundMinutes: 0, returnMinutes: 0 },
    pickupType: null,
    equipmentTypes: EQUIPMENT_TYPES,
    accessConditions: ACCESS_CONDITIONS,
    settings: { ...SETTINGS, baseTripCharge: 0, minimumServiceCharge: 75 },
  });
  // subtotal = assembly 50 + travelLabor ((0+20)/60*2*25=16.67) = 66.67 -> min bumps to 75
  assert.equal(r.pricing.minimumChargeAdjustment, 8.33);
  assert.equal(r.finalTotal, 75);
});

test("web and functions copies of pricing.mjs are identical", () => {
  const a = readFileSync(fileURLToPath(new URL("../web/js/pricing.mjs", import.meta.url)), "utf8");
  const b = readFileSync(fileURLToPath(new URL("../functions/pricing.mjs", import.meta.url)), "utf8");
  assert.equal(a, b, "functions/pricing.mjs is stale — re-copy from web/js/pricing.mjs");
});
