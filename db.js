const { Pool } = require("pg");
const { getCountryName } = require("./profileUtils");

class ConfigurationError extends Error {}

const connectionString =
  process.env.backend_practice_DATABASE_URL ||
  process.env.backend_practice_POSTGRES_URL ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL;
const shouldUseSsl =
  connectionString &&
  !connectionString.includes("localhost") &&
  !connectionString.includes("127.0.0.1");

const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: shouldUseSsl ? { rejectUnauthorized: false } : false
    })
  : null;

let databaseReadyPromise;

const PROFILE_COLUMNS = `
  id,
  name,
  gender,
  gender_probability,
  age,
  age_group,
  country_id,
  country_name,
  country_probability,
  created_at
`;

function formatProfile(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    gender: row.gender,
    gender_probability: Number(row.gender_probability),
    age: Number(row.age),
    age_group: row.age_group,
    country_id: row.country_id,
    country_name: row.country_name || getCountryName(row.country_id),
    country_probability: Number(row.country_probability),
    created_at: new Date(row.created_at).toISOString()
  };
}

async function query(text, values = []) {
  if (!pool) {
    throw new ConfigurationError(
      "Database is not configured. Set DATABASE_URL or POSTGRES_URL."
    );
  }

  return pool.query(text, values);
}

async function backfillCountryNames() {
  const result = await query(
    "SELECT id, country_id FROM profiles WHERE country_name IS NULL OR country_name = ''"
  );

  await Promise.all(
    result.rows.map((row) =>
      query("UPDATE profiles SET country_name = $1 WHERE id = $2", [
        getCountryName(row.country_id),
        row.id
      ])
    )
  );
}

async function ensureDatabaseReady() {
  if (!databaseReadyPromise) {
    databaseReadyPromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS profiles (
          id UUID PRIMARY KEY,
          name VARCHAR NOT NULL UNIQUE,
          gender VARCHAR NOT NULL,
          gender_probability DOUBLE PRECISION NOT NULL,
          age INT NOT NULL,
          age_group VARCHAR NOT NULL,
          country_id VARCHAR(2) NOT NULL,
          country_name VARCHAR NOT NULL,
          country_probability DOUBLE PRECISION NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);

      await query("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS country_name VARCHAR");
      await query("ALTER TABLE profiles DROP COLUMN IF EXISTS sample_size");
      await query("ALTER TABLE profiles ALTER COLUMN name TYPE VARCHAR");
      await query("ALTER TABLE profiles ALTER COLUMN gender TYPE VARCHAR");
      await query("ALTER TABLE profiles ALTER COLUMN age_group TYPE VARCHAR");
      await query("ALTER TABLE profiles ALTER COLUMN country_id TYPE VARCHAR(2)");
      await query("ALTER TABLE profiles ALTER COLUMN created_at SET DEFAULT now()");

      await backfillCountryNames();
      await query("ALTER TABLE profiles ALTER COLUMN country_name SET NOT NULL");

      await query("CREATE INDEX IF NOT EXISTS idx_profiles_gender ON profiles (gender)");
      await query("CREATE INDEX IF NOT EXISTS idx_profiles_age_group ON profiles (age_group)");
      await query("CREATE INDEX IF NOT EXISTS idx_profiles_country_id ON profiles (country_id)");
      await query("CREATE INDEX IF NOT EXISTS idx_profiles_age ON profiles (age)");
      await query(
        "CREATE INDEX IF NOT EXISTS idx_profiles_gender_probability ON profiles (gender_probability)"
      );
      await query(
        "CREATE INDEX IF NOT EXISTS idx_profiles_country_probability ON profiles (country_probability)"
      );
      await query("CREATE INDEX IF NOT EXISTS idx_profiles_created_at ON profiles (created_at)");
    })().catch((error) => {
      databaseReadyPromise = null;
      throw error;
    });
  }

  return databaseReadyPromise;
}

async function getProfileByName(name) {
  const result = await query(
    `SELECT ${PROFILE_COLUMNS} FROM profiles WHERE name = $1 LIMIT 1`,
    [name]
  );

  return formatProfile(result.rows[0]);
}

async function getProfileById(id) {
  const result = await query(
    `SELECT ${PROFILE_COLUMNS} FROM profiles WHERE id = $1 LIMIT 1`,
    [id]
  );

  return formatProfile(result.rows[0]);
}

function buildProfileWhereClause(filters, values) {
  const clauses = [];

  if (filters.gender) {
    values.push(filters.gender);
    clauses.push(`gender = $${values.length}`);
  }

  if (filters.country_id) {
    values.push(filters.country_id);
    clauses.push(`country_id = $${values.length}`);
  }

  if (filters.age_group) {
    values.push(filters.age_group);
    clauses.push(`age_group = $${values.length}`);
  }

  if (filters.min_age !== undefined) {
    values.push(filters.min_age);
    clauses.push(`age >= $${values.length}`);
  }

  if (filters.max_age !== undefined) {
    values.push(filters.max_age);
    clauses.push(`age <= $${values.length}`);
  }

  if (filters.min_gender_probability !== undefined) {
    values.push(filters.min_gender_probability);
    clauses.push(`gender_probability >= $${values.length}`);
  }

  if (filters.min_country_probability !== undefined) {
    values.push(filters.min_country_probability);
    clauses.push(`country_probability >= $${values.length}`);
  }

  return clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
}

async function listProfiles(options) {
  const values = [];
  const whereClause = buildProfileWhereClause(options.filters, values);
  const sortBy = options.sort_by;
  const order = options.order;
  const limit = options.limit;
  const offset = (options.page - 1) * options.limit;

  const countResult = await query(
    `SELECT COUNT(*)::int AS total FROM profiles ${whereClause}`,
    values
  );

  values.push(limit);
  const limitPlaceholder = `$${values.length}`;
  values.push(offset);
  const offsetPlaceholder = `$${values.length}`;

  const result = await query(
    `
      SELECT ${PROFILE_COLUMNS}
      FROM profiles
      ${whereClause}
      ORDER BY ${sortBy} ${order}, id ASC
      LIMIT ${limitPlaceholder}
      OFFSET ${offsetPlaceholder}
    `,
    values
  );

  return {
    total: Number(countResult.rows[0]?.total ?? 0),
    profiles: result.rows.map(formatProfile)
  };
}

async function createProfile(profile) {
  const result = await query(
    `
      INSERT INTO profiles (
        id,
        name,
        gender,
        gender_probability,
        age,
        age_group,
        country_id,
        country_name,
        country_probability,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, now()))
      ON CONFLICT (name) DO NOTHING
      RETURNING ${PROFILE_COLUMNS}
    `,
    [
      profile.id,
      profile.name,
      profile.gender,
      profile.gender_probability,
      profile.age,
      profile.age_group,
      profile.country_id,
      profile.country_name || getCountryName(profile.country_id),
      profile.country_probability,
      profile.created_at || null
    ]
  );

  if (result.rows[0]) {
    return {
      created: true,
      profile: formatProfile(result.rows[0])
    };
  }

  return {
    created: false,
    profile: await getProfileByName(profile.name)
  };
}

async function upsertProfiles(profiles) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let upserted = 0;
    const batchSize = 500;

    for (let start = 0; start < profiles.length; start += batchSize) {
      const batch = profiles.slice(start, start + batchSize);
      const values = [];
      const rows = batch.map((profile, index) => {
        const parameterOffset = index * 10;
        values.push(
          profile.id,
          profile.name,
          profile.gender,
          profile.gender_probability,
          profile.age,
          profile.age_group,
          profile.country_id,
          profile.country_name || getCountryName(profile.country_id),
          profile.country_probability,
          profile.created_at || null
        );

        return `($${parameterOffset + 1}, $${parameterOffset + 2}, $${parameterOffset + 3}, $${parameterOffset + 4}, $${parameterOffset + 5}, $${parameterOffset + 6}, $${parameterOffset + 7}, $${parameterOffset + 8}, $${parameterOffset + 9}, COALESCE($${parameterOffset + 10}, now()))`;
      });

      await client.query(
        `
          INSERT INTO profiles (
            id,
            name,
            gender,
            gender_probability,
            age,
            age_group,
            country_id,
            country_name,
            country_probability,
            created_at
          )
          VALUES ${rows.join(", ")}
          ON CONFLICT (name) DO UPDATE SET
            gender = EXCLUDED.gender,
            gender_probability = EXCLUDED.gender_probability,
            age = EXCLUDED.age,
            age_group = EXCLUDED.age_group,
            country_id = EXCLUDED.country_id,
            country_name = EXCLUDED.country_name,
            country_probability = EXCLUDED.country_probability
        `,
        values
      );
      upserted += batch.length;
    }

    await client.query("COMMIT");
    return upserted;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function deleteProfileById(id) {
  const result = await query(
    "DELETE FROM profiles WHERE id = $1 RETURNING id",
    [id]
  );

  return Boolean(result.rows[0]);
}

module.exports = {
  ConfigurationError,
  createProfile,
  deleteProfileById,
  ensureDatabaseReady,
  getProfileById,
  getProfileByName,
  listProfiles,
  upsertProfiles
};
