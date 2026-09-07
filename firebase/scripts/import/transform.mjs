import {
  excelSerialToDate, laDateString, str, num, numOrNull, bool, phoneDigits, actorName,
} from "./lib/excel.mjs";

const RETIRED_LOGINS = new Set(["piasemployee@gmail.com"]);

// StaffProfiles cleanup: full names for the two Dustins, and move Parker Brown
// off the retired gmail account onto the shared employee login.
const STAFF_DISPLAY_OVERRIDE = {
  "STF-003": "Dustin Moore",
  "SFT-009": "Dustin Van Zandt",
};
const STAFF_LOGIN_OVERRIDE = {
  "STF-008": "employee@playitagainsoquel.com", // Parker Brown
};

const slug = (s) =>
  str(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const PRICING_KEYS = [
  "LaborRatePerEmployeeHour", "VehicleRatePerMile", "BaseTripCharge",
  "MinimumServiceCharge", "PriceRoundingIncrement", "UsedItemDeliveryCharge",
  "TradeInPickupDiscount",
];
const SCHEDULING_KEYS = [
  "StoreAddress", "ConfirmationBufferMinutes", "TentativeExpirationHours",
  "BuildAlertHours", "NoAnswerHoldMinutes", "OfflineCacheDays", "UsedPhotoRetentionDays",
];

function statusEnum(name) {
  const n = str(name).toLowerCase();
  if (n === "scheduled") return "scheduled";
  if (n === "completed") return "completed";
  if (n === "cancelled" || n === "canceled") return "cancelled";
  return "unscheduled"; // Quote + Tentative are retired
}

function jobTypeKind(name) {
  const n = str(name).toLowerCase();
  const d = /deliver/.test(n);
  const p = /pick ?up/.test(n);
  if (d && p) return "delivery+pickup";
  if (p) return "pickup";
  return "delivery";
}

function decodeResponses(json) {
  try {
    return JSON.parse(str(json) || "{}");
  } catch {
    return {};
  }
}

export function transform(sheets) {
  const writes = [];
  const w = (path, id, data) => writes.push({ path, id: String(id), data });
  const S = (name) => sheets[name] || [];

  // --- lookup maps -------------------------------------------------------
  const loginEmailById = {};
  for (const r of S("LoginAccounts")) {
    loginEmailById[str(r.LoginAccountID)] = str(r.GoogleEmail).toLowerCase();
  }
  const statusNameById = {};
  for (const r of S("Statuses")) statusNameById[str(r.StatusID)] = str(r.StatusName);
  const jobTypeById = {};
  for (const r of S("JobTypes")) jobTypeById[str(r.JobTypeID)] = str(r.JobTypeName);
  const accessNameById = {};
  for (const r of S("AccessConditions")) accessNameById[str(r.AccessConditionID)] = str(r.AccessConditionName);

  const customerById = {};
  for (const r of S("Customers")) {
    const id = str(r.CustomerID);
    customerById[id] = {
      name: [str(r.FirstName), str(r.LastName)].filter(Boolean).join(" ") || str(r.CompanyName) || id,
      phone: phoneDigits(r.PrimaryPhone),
    };
  }
  const addressById = {};
  for (const r of S("CustomerAddresses")) {
    addressById[str(r.AddressID)] = {
      formatted: str(r.FormattedAddress),
      placeId: str(r.PlaceID),
    };
  }

  // --- gpRoles ---------------------------------------------------------
  for (const r of S("Roles")) {
    w("gpRoles", str(r.RoleID), {
      name: str(r.RoleName),
      active: bool(r.Active),
      permissions: {
        canCreateQuote: bool(r.CanCreateQuote),
        canCreateTentative: bool(r.CanCreateTentative),
        canApproveSchedule: bool(r.CanApproveSchedule),
        canOverrideConflict: bool(r.CanOverrideConflict),
        canOverridePrice: bool(r.CanOverridePrice),
        canOverrideDuration: bool(r.CanOverrideDuration),
        canEditCMS: bool(r.CanEditCMS),
      },
    });
  }

  // --- gpLoginAccounts (doc id = email) -------------------------------
  for (const r of S("LoginAccounts")) {
    const email = str(r.GoogleEmail).toLowerCase();
    if (!email) continue;
    w("gpLoginAccounts", email, {
      loginAccountId: str(r.LoginAccountID),
      sharedAccount: bool(r.SharedAccount),
      active: RETIRED_LOGINS.has(email) ? false : bool(r.Active),
      retired: RETIRED_LOGINS.has(email) || undefined,
    });
  }

  // --- gpStaff (doc id = name slug) ----------------------------------
  for (const r of S("StaffProfiles")) {
    const legacyId = str(r.StaffProfileID);
    const displayName = STAFF_DISPLAY_OVERRIDE[legacyId] || str(r.DisplayName);
    const loginEmail =
      STAFF_LOGIN_OVERRIDE[legacyId] ||
      loginEmailById[str(r.LoginAccountID)] ||
      "";
    w("gpStaff", slug(displayName), {
      legacyId,
      displayName,
      loginEmail,
      roleId: str(r.RoleID),
      pinEnabled: bool(r.PINEnabled),
      pinHash: str(r.PINHash) || null, // salted "v1$salt$hash" format preserved
      active: bool(r.Active),
    });
  }

  // --- reference tables --------------------------------------------
  for (const r of S("EquipmentTypes")) {
    w("gpEquipmentTypes", str(r.EquipmentTypeID), {
      name: str(r.EquipmentTypeName),
      deliveryMinutes: num(r.DeliveryMinutes),
      pickupMinutes: num(r.PickupMinutes),
      assemblyMinutes: num(r.AssemblyMinutes),
      pickupDisassemblyMinutes: num(r.PickupDisassemblyMinutes),
      defaultCrewSize: num(r.DefaultCrewSize) || num(r.MinimumCrewSize) || 1,
      defaultAssemblyCharge: num(r.DefaultAssemblyCharge),
      defaultDisposalCharge: num(r.DefaultDisposalCharge),
      defaultPickupDisassemblyCharge: num(r.DefaultPickupDisassemblyCharge),
      iconName: str(r.IconName),
      active: bool(r.Active),
      sortOrder: num(r.SortOrder),
    });
  }
  for (const r of S("AccessConditions")) {
    w("gpAccessConditions", str(r.AccessConditionID), {
      name: str(r.AccessConditionName),
      defaultMinutes: num(r.DefaultMinutes),
      flatCharge: num(r.FlatCharge),
      chargeMethod: str(r.ChargeMethod),
      active: bool(r.Active),
      sortOrder: num(r.SortOrder),
    });
  }
  for (const r of S("JobTypes")) {
    w("gpJobTypes", str(r.JobTypeID), {
      name: str(r.JobTypeName),
      kind: jobTypeKind(r.JobTypeName),
      description: str(r.Description),
      active: bool(r.Active),
      sortOrder: num(r.SortOrder),
    });
  }
  for (const r of S("Brands")) {
    w("gpBrands", str(r.BrandID), { name: str(r.BrandName), active: bool(r.Active) });
  }
  for (const r of S("Products")) {
    w("gpProducts", str(r.ProductID), {
      equipmentTypeId: str(r.EquipmentTypeID),
      brandId: str(r.BrandID),
      model: str(r.ModelName),
      imageUrl: str(r.ImageURL || r.ThumbnailURL),
      active: bool(r.Active),
    });
  }
  for (const r of S("AvailabilityRules")) {
    w("gpAvailabilityRules", str(r.AvailabilityRuleID), {
      day: str(r.DayOfWeek),
      available: bool(r.Available),
      startTime: str(r.StartTime) || null,
      endTime: str(r.EndTime) || null,
      overrideAllowed: bool(r.OverrideAllowed),
      active: bool(r.Active),
    });
  }
  for (const r of S("BlackoutDates")) {
    const id = str(r.BlackoutDateID || r.ID) || slug(str(r.StartDate || r.Date) + "-" + str(r.Reason));
    w("gpBlackoutDates", id, {
      startDate: laDateString(excelSerialToDate(r.StartDate || r.Date)),
      endDate: laDateString(excelSerialToDate(r.EndDate || r.StartDate || r.Date)),
      reason: str(r.Reason || r.Description),
      overrideAllowed: bool(r.OverrideAllowed),
    });
  }

  // --- gpConfig ---------------------------------------------------
  const settingsMap = {};
  for (const r of S("Settings")) settingsMap[str(r.SettingKey)] = r.SettingValue;
  const pricing = {};
  for (const k of PRICING_KEYS) pricing[k[0].toLowerCase() + k.slice(1)] = num(settingsMap[k]);
  w("gpConfig", "pricing", pricing);
  const scheduling = { workingSetRetentionDays: 30 };
  for (const k of SCHEDULING_KEYS) {
    const key = k[0].toLowerCase() + k.slice(1);
    scheduling[key] = k === "StoreAddress" ? str(settingsMap[k]) : num(settingsMap[k]);
  }
  w("gpConfig", "scheduling", scheduling);

  // --- gpCustomers + addresses ---------------------------------
  for (const r of S("Customers")) {
    const id = str(r.CustomerID);
    w("gpCustomers", id, {
      firstName: str(r.FirstName),
      lastName: str(r.LastName),
      name: customerById[id]?.name || id,
      companyName: str(r.CompanyName),
      primaryPhone: phoneDigits(r.PrimaryPhone),
      primaryPhoneDisplay: str(r.PrimaryPhone),
      secondaryPhone: phoneDigits(r.SecondaryPhone),
      email: str(r.Email),
      preferredContact: str(r.PreferredContact),
      generalNotes: str(r.GeneralNotes),
      active: bool(r.Active),
      createdAt: excelSerialToDate(r.CreatedAt),
      updatedAt: excelSerialToDate(r.UpdatedAt),
    });
  }
  for (const r of S("CustomerAddresses")) {
    const cid = str(r.CustomerID);
    w(`gpCustomers/${cid}/addresses`, str(r.AddressID), {
      label: str(r.AddressLabel) || "Service Address",
      formattedAddress: str(r.FormattedAddress),
      placeId: str(r.PlaceID) || null,
      latitude: numOrNull(r.Latitude),
      longitude: numOrNull(r.Longitude),
      accessNotes: str(r.AccessNotes),
      isDefault: bool(r.DefaultAddress),
      active: bool(r.Active),
    });
  }

  // --- gpJobs + subcollections --------------------------------
  const equipmentByJob = groupBy(S("JobEquipment"), "JobID");
  const accessByJob = groupBy(S("JobAccess"), "JobID");
  const historyByJob = groupBy(S("JobHistory"), "JobID");
  const inspectionsByJob = groupBy(S("PickupInspections"), "JobID");
  const inspItemsByInspection = groupBy(S("PickupInspectionItems"), "PickupInspectionID");

  for (const r of S("Jobs")) {
    const jobId = str(r.JobID);
    const cust = customerById[str(r.CustomerID)] || {};
    const addr = addressById[str(r.ServiceAddressID)] || {};
    const scheduledAt = excelSerialToDate(r.ScheduledConfirmationTime);

    w("gpJobs", jobId, {
      jobNumber: str(r.JobNumber),
      status: statusEnum(statusNameById[str(r.StatusID)]),
      legacyStatus: statusNameById[str(r.StatusID)] || str(r.StatusID),
      jobType: jobTypeKind(jobTypeById[str(r.JobTypeID)]),
      jobTypeName: jobTypeById[str(r.JobTypeID)] || str(r.JobTypeID),
      archived: true, // every imported job is history

      customerId: str(r.CustomerID),
      customerName: cust.name || "",
      customerPhone: cust.phone || "",
      serviceAddressId: str(r.ServiceAddressID),
      serviceAddress: addr.formatted || str(r.DestinationAddress),
      servicePlaceId: addr.placeId || str(r.DestinationPlaceID) || null,

      scheduledAt,
      scheduledDate: laDateString(scheduledAt),
      durationMinutes: num(r.ScheduledDurationMinutes) || num(r.CalculatedDurationMinutes),

      route: {
        provider: str(r.RouteProvider),
        originAddress: str(r.OriginAddress),
        destinationAddress: str(r.DestinationAddress),
        oneWayMiles: num(r.OneWayDistanceMiles),
        roundTripMiles: num(r.RoundTripDistanceMiles),
        outboundMinutes: num(r.OutboundTravelMinutes),
        returnMinutes: num(r.ReturnTravelMinutes),
        status: str(r.RouteStatus),
        calculatedAt: excelSerialToDate(r.RouteCalculatedAt),
      },
      pricing: {
        baseTripCharge: num(r.BaseTripCharge),
        mileageCharge: num(r.MileageCharge),
        travelLaborCharge: num(r.TravelLaborCharge),
        usedItemDeliveryCharge: num(r.UsedItemDeliveryCharge),
        assemblyCharge: num(r.AssemblyCharge),
        onSiteServiceCharge: num(r.OnSiteServiceCharge),
        pickupDisassemblyCharge: num(r.PickupDisassemblyCharge),
        disposalCharge: num(r.DisposalCharge),
        accessLaborCharge: num(r.AccessLaborCharge),
        specialHandlingCharge: num(r.SpecialHandlingCharge),
        calculatedSubtotal: num(r.CalculatedSubtotal),
        minimumChargeAdjustment: num(r.MinimumChargeAdjustment),
        manualAdjustment: num(r.ManualAdjustment),
        roundedTotal: num(r.RoundedTotal),
      },
      finalTotal: num(r.FinalTotal || r.RoundedTotal),

      pickupType: str(r.PickupType) || null,
      pickupNotes: str(r.PickupNotes),
      pickupInspectionStatus: str(r.PickupInspectionStatus) || "not-needed",
      hasBuildItems: bool(r.HasBuildRequiredItems),
      allItemsBuilt: bool(r.AllItemsBuilt),
      detailsStatus: str(r.DetailsStatus) || "needed",

      internalNotes: str(r.InternalNotes),
      customerNotes: str(r.CustomerNotes),
      isPiggyback: /^\[PIGGYBACK/i.test(str(r.InternalNotes)),

      createdBy: actorName(r.CreatedBy),
      createdAt: excelSerialToDate(r.CreatedAt),
      updatedBy: actorName(r.UpdatedBy),
      updatedAt: excelSerialToDate(r.UpdatedAt),
      completedAt: excelSerialToDate(r.CompletedAt),
    });

    for (const e of equipmentByJob[jobId] || []) {
      w(`gpJobs/${jobId}/equipment`, str(e.JobEquipmentID), {
        equipmentTypeId: str(e.EquipmentTypeID),
        condition: str(e.Condition).toLowerCase() || "used",
        brand: str(e.Brand),
        model: str(e.Model),
        itemDescription: str(e.ItemDescription),
        productId: str(e.ProductID) || null,
        quantity: Math.max(1, num(e.Quantity) || 1),
        imageUrl: str(e.ImageURL),
        deliveryRequired: bool(e.DeliveryRequired),
        pickupRequired: bool(e.PickupRequired),
        buildRequired: bool(e.BuildRequired),
        buildComplete: bool(e.BuildComplete),
        buildCompletedBy: actorName(e.BuildCompletedBy || e.BuiltBy),
        buildCompletedAt: excelSerialToDate(e.BuildCompletedAt || e.BuiltAt),
        calculatedServiceMinutes: num(e.CalculatedServiceMinutes),
        minimumCrewSize: num(e.MinimumCrewSize),
        specialNotes: str(e.SpecialNotes),
        sortOrder: num(e.SortOrder),
        active: bool(e.Active),
      });
    }
    for (const a of accessByJob[jobId] || []) {
      w(`gpJobs/${jobId}/access`, str(a.JobAccessID), {
        accessConditionId: str(a.AccessConditionID),
        name: accessNameById[str(a.AccessConditionID)] || str(a.AccessConditionID),
        quantity: Math.max(1, num(a.Quantity) || 1),
        addedMinutes: num(a.AddedMinutes),
        addedLaborCharge: num(a.AddedLaborCharge),
        notes: str(a.Notes),
        active: bool(a.Active),
      });
    }
    for (const h of historyByJob[jobId] || []) {
      w(`gpJobs/${jobId}/history`, str(h.HistoryID), {
        eventType: str(h.EventType),
        description: str(h.EventDescription),
        previousValue: str(h.PreviousValue),
        newValue: str(h.NewValue),
        performedBy: str(h.PerformedBy),
        performedAt: excelSerialToDate(h.PerformedAt),
        source: str(h.Source),
      });
    }
    for (const insp of inspectionsByJob[jobId] || []) {
      const inspId = str(insp.PickupInspectionID);
      const items = (inspItemsByInspection[inspId] || []).map((it) => ({
        jobEquipmentId: str(it.JobEquipmentID),
        responses: decodeResponses(it.ResponsesJSON),
        issueSummary: str(it.IssueSummary),
        photoUrl: str(it.PhotoURL),
        disassembled: bool(it.Disassembled),
        disassemblyNotes: str(it.DisassemblyNotes),
        notes: str(it.ItemNotes),
      }));
      w(`gpJobs/${jobId}/pickupInspection`, inspId, {
        pickupType: str(insp.PickupType),
        overallCondition: str(insp.OverallCondition),
        additionalNotes: str(insp.AdditionalNotes),
        customerName: str(insp.CustomerName),
        signatureUrl: str(insp.CustomerSignatureURL),
        completedBy: actorName(insp.CompletedBy),
        completedAt: excelSerialToDate(insp.CompletedAt),
        issueCount: num(insp.IssueCount),
        photoCount: num(insp.PhotoCount),
        status: str(insp.Status) || "Complete",
        items,
      });
    }
  }

  // --- gpAudit (staff + customer logs) ------------------------
  for (const r of S("StaffAuditLog")) {
    w("gpAudit", str(r.AuditID), auditDoc("staff", r.StaffProfileID, r));
  }
  for (const r of S("CustomerAuditLog")) {
    w("gpAudit", str(r.AuditID), auditDoc("customer", r.CustomerID, r));
  }

  return writes;
}

function auditDoc(entity, entityId, r) {
  return {
    entity,
    entityId: str(entityId),
    action: str(r.Action),
    oldValue: str(r.OldValue),
    newValue: str(r.NewValue),
    performedBy: str(r.PerformedBy),
    performedAt: excelSerialToDate(r.PerformedAt),
    source: str(r.Source),
  };
}

function groupBy(rows, key) {
  const out = {};
  for (const r of rows) {
    const k = String(r[key] ?? "").trim();
    if (!k) continue;
    (out[k] ||= []).push(r);
  }
  return out;
}
