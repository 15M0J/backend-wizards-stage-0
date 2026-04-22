const fs = require("fs/promises");
const path = require("path");
const {
  ensureDatabaseReady,
  upsertProfiles
} = require("../db");
const {
  AGE_GROUPS,
  GENDERS,
  generateUuidV7,
  getAgeGroup,
  getCountryName,
  isUuidV7,
  normalizeFilter,
  normalizeName
} = require("../profileUtils");

function usage() {
  console.error("Usage: npm run seed -- <profiles-json-file-or-url>");
}

async function readSeedSource(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);

    if (!response.ok) {
      throw new Error(`Seed download failed with status ${response.status}`);
    }

    return response.json();
  }

  const filePath = path.resolve(process.cwd(), source);
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
}

function asNumber(value, fieldName) {
  const parsed = Number(value);

  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${fieldName}`);
  }

  return parsed;
}

function asProbability(value, fieldName) {
  const parsed = asNumber(value, fieldName);

  if (parsed < 0 || parsed > 1) {
    throw new Error(`Invalid ${fieldName}`);
  }

  return parsed;
}

function normalizeProfile(rawProfile, index) {
  const name = typeof rawProfile.name === "string" ? normalizeName(rawProfile.name) : "";
  const gender =
    typeof rawProfile.gender === "string" ? normalizeFilter(rawProfile.gender) : "";
  const age = asNumber(rawProfile.age, `age at row ${index + 1}`);
  const ageGroup =
    typeof rawProfile.age_group === "string"
      ? normalizeFilter(rawProfile.age_group)
      : getAgeGroup(age);
  const countryId =
    typeof rawProfile.country_id === "string"
      ? rawProfile.country_id.trim().toUpperCase()
      : "";

  if (!name) {
    throw new Error(`Missing name at row ${index + 1}`);
  }

  if (!GENDERS.has(gender)) {
    throw new Error(`Invalid gender at row ${index + 1}`);
  }

  if (!Number.isInteger(age) || age < 0 || age > 130) {
    throw new Error(`Invalid age at row ${index + 1}`);
  }

  if (!AGE_GROUPS.has(ageGroup)) {
    throw new Error(`Invalid age_group at row ${index + 1}`);
  }

  if (!/^[A-Z]{2}$/.test(countryId)) {
    throw new Error(`Invalid country_id at row ${index + 1}`);
  }

  const id =
    typeof rawProfile.id === "string" && isUuidV7(rawProfile.id)
      ? rawProfile.id
      : generateUuidV7();

  return {
    id,
    name,
    gender,
    gender_probability: asProbability(
      rawProfile.gender_probability,
      `gender_probability at row ${index + 1}`
    ),
    age,
    age_group: ageGroup,
    country_id: countryId,
    country_name:
      typeof rawProfile.country_name === "string" && rawProfile.country_name.trim()
        ? rawProfile.country_name.trim()
        : getCountryName(countryId),
    country_probability: asProbability(
      rawProfile.country_probability,
      `country_probability at row ${index + 1}`
    ),
    created_at: rawProfile.created_at ? new Date(rawProfile.created_at).toISOString() : null
  };
}

async function main() {
  const source = process.argv[2] || process.env.SEED_SOURCE;

  if (!source) {
    usage();
    process.exitCode = 1;
    return;
  }

  const payload = await readSeedSource(source);
  const rawProfiles = Array.isArray(payload) ? payload : payload.profiles || payload.data;

  if (!Array.isArray(rawProfiles)) {
    throw new Error("Seed JSON must be an array or contain a profiles/data array");
  }

  await ensureDatabaseReady();
  const profiles = rawProfiles.map(normalizeProfile);
  const upserted = await upsertProfiles(profiles);

  console.log(`Seed complete. Upserted ${upserted} profiles.`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
