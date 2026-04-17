const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { randomBytes } = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "profiles.json");
const GENDERIZE_API = "https://api.genderize.io";
const AGIFY_API = "https://api.agify.io";
const NATIONALIZE_API = "https://api.nationalize.io";

class UpstreamValidationError extends Error {
  constructor(apiName) {
    super(`${apiName} returned an invalid response`);
    this.apiName = apiName;
  }
}

function ensureDataFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, "[]\n", "utf8");
  }
}

function loadProfiles() {
  ensureDataFile();

  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

let profiles = loadProfiles();
const pendingProfiles = new Map();

function persistProfiles() {
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(profiles, null, 2)}\n`, "utf8");
}

function normalizeName(name) {
  return name.trim().toLowerCase();
}

function normalizeFilter(value) {
  return value.trim().toLowerCase();
}

function isInvalidStringValue(value) {
  return Array.isArray(value) || (value !== undefined && typeof value !== "string");
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

function formatProfileSummary(profile) {
  return {
    id: profile.id,
    name: profile.name,
    gender: profile.gender,
    age: profile.age,
    age_group: profile.age_group,
    country_id: profile.country_id
  };
}

function findProfileById(id) {
  return profiles.find((profile) => profile.id === id);
}

function findProfileByName(name) {
  return profiles.find((profile) => profile.name === name);
}

async function fetchGender(name) {
  let response;

  try {
    response = await axios.get(GENDERIZE_API, {
      params: { name },
      timeout: 8000
    });
  } catch (error) {
    throw new UpstreamValidationError("Genderize");
  }

  const { gender, probability, count } = response.data ?? {};
  const genderProbability = Number(probability);
  const sampleSize = Number(count);

  if (
    gender === null ||
    sampleSize === 0 ||
    Number.isNaN(genderProbability) ||
    Number.isNaN(sampleSize)
  ) {
    throw new UpstreamValidationError("Genderize");
  }

  return {
    gender,
    gender_probability: genderProbability,
    sample_size: sampleSize
  };
}

async function fetchAge(name) {
  let response;

  try {
    response = await axios.get(AGIFY_API, {
      params: { name },
      timeout: 8000
    });
  } catch (error) {
    throw new UpstreamValidationError("Agify");
  }

  const ageValue = response.data?.age;
  const age = Number(ageValue);

  if (ageValue === null || Number.isNaN(age)) {
    throw new UpstreamValidationError("Agify");
  }

  return {
    age,
    age_group: getAgeGroup(age)
  };
}

async function fetchNationality(name) {
  let response;

  try {
    response = await axios.get(NATIONALIZE_API, {
      params: { name },
      timeout: 8000
    });
  } catch (error) {
    throw new UpstreamValidationError("Nationalize");
  }

  const countries = response.data?.country;

  if (!Array.isArray(countries) || countries.length === 0) {
    throw new UpstreamValidationError("Nationalize");
  }

  const bestMatch = countries.reduce((highest, current) => {
    if (
      !highest ||
      Number(current?.probability) > Number(highest?.probability)
    ) {
      return current;
    }

    return highest;
  }, null);

  const countryId = bestMatch?.country_id;
  const countryProbability = Number(bestMatch?.probability);

  if (!countryId || Number.isNaN(countryProbability)) {
    throw new UpstreamValidationError("Nationalize");
  }

  return {
    country_id: countryId,
    country_probability: countryProbability
  };
}

async function buildProfile(name) {
  const [genderData, ageData, nationalityData] = await Promise.all([
    fetchGender(name),
    fetchAge(name),
    fetchNationality(name)
  ]);

  return {
    id: generateUuidV7(),
    name,
    gender: genderData.gender,
    gender_probability: genderData.gender_probability,
    sample_size: genderData.sample_size,
    age: ageData.age,
    age_group: ageData.age_group,
    country_id: nationalityData.country_id,
    country_probability: nationalityData.country_probability,
    created_at: new Date().toISOString()
  };
}

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  return next();
});

app.use(express.json());

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return res.status(400).json({
      status: "error",
      message: "Invalid JSON body"
    });
  }

  return next(error);
});

app.get("/", (req, res) => {
  return res.json({ message: "Server is running" });
});

app.post("/api/profiles", async (req, res, next) => {
  try {
    const { name } = req.body ?? {};

    if (isInvalidStringValue(name)) {
      return res.status(422).json({
        status: "error",
        message: "Invalid type"
      });
    }

    if (name === undefined || name.trim() === "") {
      return res.status(400).json({
        status: "error",
        message: "Missing or empty name"
      });
    }

    const normalizedName = normalizeName(name);
    const existingProfile = findProfileByName(normalizedName);

    if (existingProfile) {
      return res.status(200).json({
        status: "success",
        message: "Profile already exists",
        data: existingProfile
      });
    }

    if (pendingProfiles.has(normalizedName)) {
      const pendingProfile = await pendingProfiles.get(normalizedName);

      return res.status(200).json({
        status: "success",
        message: "Profile already exists",
        data: pendingProfile
      });
    }

    const creationPromise = buildProfile(normalizedName)
      .then((profile) => {
        profiles.push(profile);
        persistProfiles();
        return profile;
      })
      .finally(() => {
        pendingProfiles.delete(normalizedName);
      });

    pendingProfiles.set(normalizedName, creationPromise);

    const profile = await creationPromise;

    return res.status(201).json({
      status: "success",
      data: profile
    });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/profiles/:id", (req, res) => {
  const profile = findProfileById(req.params.id);

  if (!profile) {
    return res.status(404).json({
      status: "error",
      message: "Profile not found"
    });
  }

  return res.status(200).json({
    status: "success",
    data: profile
  });
});

app.get("/api/profiles", (req, res) => {
  const { gender, country_id: countryId, age_group: ageGroup } = req.query;

  if (
    isInvalidStringValue(gender) ||
    isInvalidStringValue(countryId) ||
    isInvalidStringValue(ageGroup)
  ) {
    return res.status(422).json({
      status: "error",
      message: "Invalid type"
    });
  }

  const normalizedGender = gender ? normalizeFilter(gender) : undefined;
  const normalizedCountryId = countryId ? normalizeFilter(countryId) : undefined;
  const normalizedAgeGroup = ageGroup ? normalizeFilter(ageGroup) : undefined;

  const filteredProfiles = profiles.filter((profile) => {
    const matchesGender =
      normalizedGender === undefined ||
      profile.gender.toLowerCase() === normalizedGender;
    const matchesCountry =
      normalizedCountryId === undefined ||
      profile.country_id.toLowerCase() === normalizedCountryId;
    const matchesAgeGroup =
      normalizedAgeGroup === undefined ||
      profile.age_group.toLowerCase() === normalizedAgeGroup;

    return matchesGender && matchesCountry && matchesAgeGroup;
  });

  return res.status(200).json({
    status: "success",
    count: filteredProfiles.length,
    data: filteredProfiles.map(formatProfileSummary)
  });
});

app.delete("/api/profiles/:id", (req, res) => {
  const profileIndex = profiles.findIndex((profile) => profile.id === req.params.id);

  if (profileIndex === -1) {
    return res.status(404).json({
      status: "error",
      message: "Profile not found"
    });
  }

  profiles.splice(profileIndex, 1);
  persistProfiles();

  return res.status(204).send();
});

app.use((error, req, res, next) => {
  if (error instanceof UpstreamValidationError) {
    return res.status(502).json({
      status: "error",
      message: error.message
    });
  }

  console.error(error);

  return res.status(500).json({
    status: "error",
    message: "Internal server error"
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
