const { findCountryIdInText } = require("./countryLookup");

const FEMALE_TERMS = new Set(["female", "females", "woman", "women", "girl", "girls"]);
const MALE_TERMS = new Set(["male", "males", "man", "men", "boy", "boys"]);

function hasAny(tokens, terms) {
  return tokens.some((token) => terms.has(token));
}

function normalizeQuery(query) {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAgeFilters(text, filters) {
  const betweenMatch = text.match(/\bbetween\s+(\d{1,3})\s+(?:and|to)\s+(\d{1,3})\b/);

  if (betweenMatch) {
    filters.min_age = Number(betweenMatch[1]);
    filters.max_age = Number(betweenMatch[2]);
  }

  const minMatch = text.match(
    /\b(?:above|over|older than|at least|minimum age|min age|age above|age over)\s+(\d{1,3})\b/
  );

  if (minMatch) {
    filters.min_age = Number(minMatch[1]);
  }

  const maxMatch = text.match(
    /\b(?:below|under|younger than|less than|at most|maximum age|max age|age below|age under)\s+(\d{1,3})\b/
  );

  if (maxMatch) {
    filters.max_age = Number(maxMatch[1]);
  }

  const exactMatch = text.match(/\b(?:age|aged)\s+(\d{1,3})\b/);

  if (exactMatch && !minMatch && !maxMatch && !betweenMatch) {
    const age = Number(exactMatch[1]);
    filters.min_age = age;
    filters.max_age = age;
  }
}

function parseNaturalLanguageQuery(query) {
  const text = normalizeQuery(query);

  if (!text) {
    return null;
  }

  const tokens = text.split(" ");
  const filters = {};
  const hasMale = hasAny(tokens, MALE_TERMS);
  const hasFemale = hasAny(tokens, FEMALE_TERMS);

  if (hasMale && !hasFemale) {
    filters.gender = "male";
  }

  if (hasFemale && !hasMale) {
    filters.gender = "female";
  }

  if (tokens.some((token) => token === "young")) {
    filters.min_age = 16;
    filters.max_age = 24;
  }

  if (tokens.some((token) => token === "child" || token === "children" || token === "kids")) {
    filters.age_group = "child";
  }

  if (tokens.some((token) => token === "teenager" || token === "teenagers" || token === "teen" || token === "teens")) {
    filters.age_group = "teenager";
  }

  if (tokens.some((token) => token === "adult" || token === "adults")) {
    filters.age_group = "adult";
  }

  if (tokens.some((token) => token === "senior" || token === "seniors" || token === "elderly")) {
    filters.age_group = "senior";
  }

  parseAgeFilters(text, filters);

  const countryId = findCountryIdInText(text);

  if (countryId) {
    filters.country_id = countryId;
  }

  if (Object.keys(filters).length === 0) {
    return null;
  }

  return filters;
}

module.exports = {
  parseNaturalLanguageQuery
};
