// GamePlan pricing + duration engine — the SINGLE source of truth.
//
// Pure, dependency-free ES module. Imported by:
//   - the job wizard (live price preview, no round trip)
//   - the createJob Cloud Function (server-authoritative)   [Phase 3]
//   - the pricing dashboard simulator (dry run)             [Phase 5]
//
// Faithful port of the Apps Script `createJob_` math. Business rules kept as-is:
//   * travel is billed store -> site -> store (round trip), typical drive time
//   * assembly is a flat per-item charge, NOT added to on-site minutes
//     (new-in-box items are built at the store beforehand)
//
// The `functions/` copy is regenerated from this file on deploy — see
// firebase.json `predeploy`. `npm --prefix scripts/import test` guards drift.

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const asMap = (refs) =>
  Array.isArray(refs) ? Object.fromEntries(refs.map((r) => [r.id, r])) : refs || {};

/**
 * @param {object} input
 * @param {Array<{equipmentTypeId,condition,quantity,deliveryRequired,pickupRequired,fulfillmentConditionId}>} input.equipment
 * @param {Array<{accessConditionId,quantity}>|Array<string>} input.access
 * @param {{roundTripMiles,outboundMinutes,returnMinutes}} input.route
 * @param {"trade-in"|"disposal"|null} input.pickupType
 * @param {Array|object} input.equipmentTypes  by id: {deliveryMinutes,pickupMinutes,defaultCrewSize,minimumCrewSize,defaultAssemblyCharge,defaultDisposalCharge}
 * @param {Array|object} input.accessConditions by id: {defaultMinutes,flatCharge}
 * @param {object} input.settings  {laborRatePerEmployeeHour,vehicleRatePerMile,baseTripCharge,minimumServiceCharge,priceRoundingIncrement,usedItemDeliveryCharge,tradeInPickupDiscount}
 * @returns {{pricing:object, durationMinutes:number, crewSize:number, hasBuildItems:boolean, laborMinutes:number, travelMinutes:number}}
 */
export function computeQuote(input) {
  const equipmentTypes = asMap(input.equipmentTypes);
  const accessConditions = asMap(input.accessConditions);
  const s = input.settings || {};
  const pickupType = input.pickupType || null;

  let crewSize = 1;
  let equipmentServiceMinutes = 0;
  let assemblyCharge = 0;
  let usedItemDeliveryCharge = 0;
  let hasBuildItems = false;

  const equipment = Array.isArray(input.equipment) ? input.equipment : [];
  for (const item of equipment) {
    const type = equipmentTypes[item.equipmentTypeId];
    if (!type) throw new Error(`Unknown equipment type: ${item.equipmentTypeId}`);
    const qty = Math.max(1, n(item.quantity) || 1);
    const isNew = String(item.condition || "used").toLowerCase() === "new";
    const deliveryRequired = item.deliveryRequired !== false;
    const pickupRequired = item.pickupRequired === true;
    const fulfillmentId = item.fulfillmentConditionId || "NIB";

    const buildRequired = deliveryRequired && isNew && fulfillmentId === "NIB";
    hasBuildItems = hasBuildItems || buildRequired;

    const itemCrew = n(type.defaultCrewSize) || n(type.minimumCrewSize) || 1;
    const serviceMinutes = pickupRequired && !deliveryRequired
      ? n(type.pickupMinutes)
      : n(type.deliveryMinutes);
    const itemAssemblyCharge = isNew && deliveryRequired ? n(type.defaultAssemblyCharge) : 0;

    crewSize = Math.max(crewSize, itemCrew);
    equipmentServiceMinutes += serviceMinutes * qty;
    assemblyCharge += itemAssemblyCharge * qty;
    if (deliveryRequired && !isNew) usedItemDeliveryCharge += n(s.usedItemDeliveryCharge) * qty;
  }

  let accessMinutes = 0;
  let accessLaborCharge = 0;
  const access = Array.isArray(input.access) ? input.access : [];
  for (const a of access) {
    const id = typeof a === "string" ? a : a.accessConditionId;
    const qty = typeof a === "string" ? 1 : Math.max(1, n(a.quantity) || 1);
    const cond = accessConditions[id];
    if (!cond) throw new Error(`Unknown access condition: ${id}`);
    accessMinutes += n(cond.defaultMinutes) * qty;
    accessLaborCharge += n(cond.flatCharge) * qty;
  }

  const route = input.route || {};
  const roundTripMiles = Math.max(0, n(route.roundTripMiles));
  const outboundTravelMinutes = Math.max(0, n(route.outboundMinutes));
  const returnTravelMinutes = Math.max(0, n(route.returnMinutes));
  const travelMinutes = outboundTravelMinutes + returnTravelMinutes;

  const anyPickup = equipment.some((i) => i.pickupRequired === true);
  const disposalCharge = pickupType === "disposal"
    ? equipment.reduce((sum, i) => {
        if (i.pickupRequired !== true) return sum;
        const t = equipmentTypes[i.equipmentTypeId] || {};
        return sum + n(t.defaultDisposalCharge) * Math.max(1, n(i.quantity) || 1);
      }, 0)
    : 0;

  const mileageCharge = roundTripMiles * n(s.vehicleRatePerMile);
  const laborMinutes = travelMinutes + equipmentServiceMinutes + accessMinutes;
  const travelLaborCharge = (laborMinutes / 60) * crewSize * n(s.laborRatePerEmployeeHour);
  const tradeInPickupDiscount = pickupType === "trade-in" && anyPickup
    ? Math.max(0, n(s.tradeInPickupDiscount))
    : 0;

  const calculatedSubtotal = Math.max(0,
    n(s.baseTripCharge) + mileageCharge + travelLaborCharge +
    usedItemDeliveryCharge + assemblyCharge + disposalCharge + accessLaborCharge -
    tradeInPickupDiscount);

  const minimumChargeAdjustment = Math.max(0, n(s.minimumServiceCharge) - calculatedSubtotal);
  const roundingIncrement = Math.max(1, n(s.priceRoundingIncrement) || 5);
  const roundedTotal = Math.round((calculatedSubtotal + minimumChargeAdjustment) / roundingIncrement) * roundingIncrement;

  const durationMinutes = travelMinutes + equipmentServiceMinutes + accessMinutes;

  return {
    pricing: {
      baseTripCharge: round2(n(s.baseTripCharge)),
      mileageCharge: round2(mileageCharge),
      travelLaborCharge: round2(travelLaborCharge),
      usedItemDeliveryCharge: round2(usedItemDeliveryCharge),
      assemblyCharge: round2(assemblyCharge),
      disposalCharge: round2(disposalCharge),
      accessLaborCharge: round2(accessLaborCharge),
      tradeInPickupDiscount: round2(tradeInPickupDiscount),
      calculatedSubtotal: round2(calculatedSubtotal),
      minimumChargeAdjustment: round2(minimumChargeAdjustment),
      roundedTotal,
    },
    finalTotal: roundedTotal,
    durationMinutes,
    crewSize,
    hasBuildItems,
    laborMinutes,
    travelMinutes,
    equipmentServiceMinutes,
    accessMinutes,
    roundTripMiles,
  };
}

function round2(v) {
  return Math.round(n(v) * 100) / 100;
}
