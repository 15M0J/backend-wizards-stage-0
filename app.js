const express = require("express");
const axios = require("axios");
const {
  ConfigurationError,
  ensureDatabaseReady,
  createProfile,
  deleteProfileById,
  getProfileById,
  getProfileByName,
  listProfiles
} = require("./db");
const { parseNaturalLanguageQuery } = require("./naturalLanguageParser");
const {
  AGE_GROUPS,
  GENDERS,
  generateUuidV7,
  getAgeGroup,
  getCountryName,
  isUuidV7,
  normalizeFilter,
  normalizeName
} = require("./profileUtils");

const GENDERIZE_API = "https://api.genderize.io";
const AGIFY_API = "https://api.agify.io";
const NATIONALIZE_API = "https://api.nationalize.io";

const PROFILE_QUERY_PARAMS = new Set([
  "gender",
  "age_group",
  "country_id",
  "min_age",
  "max_age",
  "min_gender_probability",
  "min_country_probability",
  "sort_by",
  "order",
  "page",
  "limit"
]);
const SEARCH_QUERY_PARAMS = new Set(["q", "page", "limit"]);
const SORTABLE_FIELDS = new Set(["age", "created_at", "gender_probability"]);

class UpstreamValidationError extends Error {
  constructor(apiName) {
    super(`${apiName} returned an invalid response`);
    this.apiName = apiName;
  }
}

class QueryValidationError extends Error {
  constructor(statusCode = 422, message = "Invalid query parameters") {
    super(message);
    this.statusCode = statusCode;
  }
}

function isInvalidStringValue(value) {
  return Array.isArray(value) || (value !== undefined && typeof value !== "string");
}

function assertNoUnknownQueryParameters(query, allowedParameters) {
  for (const key of Object.keys(query)) {
    if (!allowedParameters.has(key)) {
      throw new QueryValidationError(400);
    }
  }
}

function getQueryString(query, key, { required = false } = {}) {
  const value = query[key];

  if (value === undefined) {
    if (required) {
      throw new QueryValidationError(400, "Missing or empty parameter");
    }

    return undefined;
  }

  if (Array.isArray(value) || typeof value !== "string") {
    throw new QueryValidationError(422);
  }

  const trimmed = value.trim();

  if (trimmed === "") {
    throw new QueryValidationError(
      400,
      required ? "Missing or empty parameter" : "Invalid query parameters"
    );
  }

  return trimmed;
}

function parseIntegerParameter(query, key, options = {}) {
  const value = getQueryString(query, key);

  if (value === undefined) {
    return options.defaultValue;
  }

  if (!/^\d+$/.test(value)) {
    throw new QueryValidationError(422);
  }

  const parsed = Number(value);

  if (
    !Number.isSafeInteger(parsed) ||
    (options.min !== undefined && parsed < options.min) ||
    (options.max !== undefined && parsed > options.max)
  ) {
    throw new QueryValidationError(422);
  }

  return parsed;
}

function parseProbabilityParameter(query, key) {
  const value = getQueryString(query, key);

  if (value === undefined) {
    return undefined;
  }

  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) {
    throw new QueryValidationError(422);
  }

  return Number(value);
}

function parsePagination(query) {
  return {
    page: parseIntegerParameter(query, "page", { defaultValue: 1, min: 1 }),
    limit: parseIntegerParameter(query, "limit", {
      defaultValue: 10,
      min: 1,
      max: 50
    })
  };
}

function validateFilters(filters) {
  if (filters.gender !== undefined && !GENDERS.has(filters.gender)) {
    throw new QueryValidationError(422);
  }

  if (filters.age_group !== undefined && !AGE_GROUPS.has(filters.age_group)) {
    throw new QueryValidationError(422);
  }

  if (
    filters.country_id !== undefined &&
    !/^[A-Z]{2}$/.test(filters.country_id)
  ) {
    throw new QueryValidationError(422);
  }

  if (
    filters.min_age !== undefined &&
    filters.max_age !== undefined &&
    filters.min_age > filters.max_age
  ) {
    throw new QueryValidationError(422);
  }
}

function parseListOptions(query) {
  assertNoUnknownQueryParameters(query, PROFILE_QUERY_PARAMS);

  const filters = {};
  const gender = getQueryString(query, "gender");
  const ageGroup = getQueryString(query, "age_group");
  const countryId = getQueryString(query, "country_id");
  const sortBy = (getQueryString(query, "sort_by") || "created_at").toLowerCase();
  const order = (getQueryString(query, "order") || "asc").toLowerCase();

  if (gender !== undefined) {
    filters.gender = normalizeFilter(gender);
  }

  if (ageGroup !== undefined) {
    filters.age_group = normalizeFilter(ageGroup);
  }

  if (countryId !== undefined) {
    filters.country_id = countryId.toUpperCase();
  }

  filters.min_age = parseIntegerParameter(query, "min_age", { min: 0, max: 130 });
  filters.max_age = parseIntegerParameter(query, "max_age", { min: 0, max: 130 });
  filters.min_gender_probability = parseProbabilityParameter(
    query,
    "min_gender_probability"
  );
  filters.min_country_probability = parseProbabilityParameter(
    query,
    "min_country_probability"
  );

  if (!SORTABLE_FIELDS.has(sortBy) || !["asc", "desc"].includes(order)) {
    throw new QueryValidationError(422);
  }

  validateFilters(filters);

  return {
    filters,
    sort_by: sortBy,
    order,
    ...parsePagination(query)
  };
}

function parseSearchOptions(query) {
  assertNoUnknownQueryParameters(query, SEARCH_QUERY_PARAMS);

  const q = getQueryString(query, "q", { required: true });
  const filters = parseNaturalLanguageQuery(q);

  if (!filters) {
    throw new QueryValidationError(400, "Unable to interpret query");
  }

  validateFilters(filters);

  return {
    filters,
    sort_by: "created_at",
    order: "asc",
    ...parsePagination(query)
  };
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
    !GENDERS.has(gender) ||
    sampleSize === 0 ||
    Number.isNaN(genderProbability) ||
    Number.isNaN(sampleSize)
  ) {
    throw new UpstreamValidationError("Genderize");
  }

  return {
    gender,
    gender_probability: genderProbability
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

  const countryId = bestMatch?.country_id?.toUpperCase();
  const countryProbability = Number(bestMatch?.probability);

  if (!countryId || Number.isNaN(countryProbability)) {
    throw new UpstreamValidationError("Nationalize");
  }

  return {
    country_id: countryId,
    country_name: getCountryName(countryId),
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
    age: ageData.age,
    age_group: ageData.age_group,
    country_id: nationalityData.country_id,
    country_name: nationalityData.country_name,
    country_probability: nationalityData.country_probability
  };
}

const app = express();

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

app.use("/api/profiles", async (req, res, next) => {
  try {
    await ensureDatabaseReady();
    return next();
  } catch (error) {
    return next(error);
  }
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
    const existingProfile = await getProfileByName(normalizedName);

    if (existingProfile) {
      return res.status(200).json({
        status: "success",
        message: "Profile already exists",
        data: existingProfile
      });
    }

    const profile = await buildProfile(normalizedName);
    const result = await createProfile(profile);

    if (!result.created) {
      return res.status(200).json({
        status: "success",
        message: "Profile already exists",
        data: result.profile
      });
    }

    return res.status(201).json({
      status: "success",
      data: result.profile
    });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/profiles/search", async (req, res, next) => {
  try {
    const options = parseSearchOptions(req.query);
    const result = await listProfiles(options);

    return res.status(200).json({
      status: "success",
      page: options.page,
      limit: options.limit,
      total: result.total,
      data: result.profiles
    });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/profiles", async (req, res, next) => {
  try {
    const options = parseListOptions(req.query);
    const result = await listProfiles(options);

    return res.status(200).json({
      status: "success",
      page: options.page,
      limit: options.limit,
      total: result.total,
      data: result.profiles
    });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/profiles/:id", async (req, res, next) => {
  try {
    if (!isUuidV7(req.params.id)) {
      return res.status(404).json({
        status: "error",
        message: "Profile not found"
      });
    }

    const profile = await getProfileById(req.params.id);

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
  } catch (error) {
    return next(error);
  }
});

app.delete("/api/profiles/:id", async (req, res, next) => {
  try {
    if (!isUuidV7(req.params.id)) {
      return res.status(404).json({
        status: "error",
        message: "Profile not found"
      });
    }

    const deleted = await deleteProfileById(req.params.id);

    if (!deleted) {
      return res.status(404).json({
        status: "error",
        message: "Profile not found"
      });
    }

    return res.status(204).send();
  } catch (error) {
    return next(error);
  }
});

app.use((error, req, res, next) => {
  if (error instanceof QueryValidationError) {
    return res.status(error.statusCode).json({
      status: "error",
      message: error.message
    });
  }

  if (error instanceof UpstreamValidationError) {
    return res.status(502).json({
      status: "error",
      message: error.message
    });
  }

  if (error instanceof ConfigurationError) {
    return res.status(500).json({
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

module.exports = app;
