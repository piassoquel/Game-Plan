import xlsx from "xlsx";

/**
 * Read the GamePlan CMS workbook. Every sheet keeps its title in rows 1-2 and
 * the real header on row 3, data from row 4 — matching the Apps Script backend
 * (`getRange(3, 1, ...)`).
 *
 * Returns { sheetName: [ {Header: value, ...}, ... ] }.
 */
export function readWorkbook(path) {
  const wb = xlsx.readFile(path, { cellDates: false });
  const out = {};
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const rows = xlsx.utils.sheet_to_json(ws, {
      range: 2, // 0-indexed: row 3 is the header
      defval: "",
      raw: true,
      blankrows: false,
    });
    // Drop fully-empty rows and the odd repeated-header row.
    out[name] = rows.filter((r) => {
      const vals = Object.values(r);
      if (!vals.some((v) => v !== "" && v != null)) return false;
      const keys = Object.keys(r);
      if (keys.length && keys.every((k) => String(r[k]).trim() === k)) return false;
      return true;
    });
  }
  return out;
}
