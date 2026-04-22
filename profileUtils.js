const { randomBytes } = require("crypto");

const AGE_GROUPS = new Set(["child", "teenager", "adult", "senior"]);
const GENDERS = new Set(["male", "female"]);

function normalizeName(name) {
  return name.trim().toLowerCase();
}

function normalizeFilter(value) {
  return value.trim().toLowerCase();
}

function getAgeGroup(age) {
  if (age <= 12) {
    return "child";
  }

  if (age <= 19) {
    return "teenager";
  }

  if (age <= 59) {
    return "adult";
  }

  return "senior";
}

function generateUuidV7() {
  const bytes = randomBytes(16);
  let timestamp = BigInt(Date.now());

  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join("-");
}

function isUuidV7(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function getCountryName(countryId) {
  if (!countryId || typeof countryId !== "string") {
    return "";
  }

  try {
    const displayNames = new Intl.DisplayNames(["en"], { type: "region" });
    return displayNames.of(countryId.toUpperCase()) || countryId.toUpperCase();
  } catch (error) {
    return countryId.toUpperCase();
  }
}

module.exports = {
  AGE_GROUPS,
  GENDERS,
  generateUuidV7,
  getAgeGroup,
  getCountryName,
  isUuidV7,
  normalizeFilter,
  normalizeName
};
