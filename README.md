# api-practice-lab

Stage 1 backend assessment solution for Backend Wizards. The API accepts a name, calls Genderize, Agify, and Nationalize, stores the classified result in a local JSON datastore, and exposes CRUD-style profile endpoints.

## Tech stack

- Node.js 22
- Express
- Axios
- File-based JSON persistence

## Run locally

```bash
npm install
npm start
```

The server runs on `http://localhost:3000` by default.

## Environment

- `PORT`: optional server port override

## Data model

Profiles are stored in [`data/profiles.json`](./data/profiles.json) with these fields:

- `id` (UUID v7)
- `name`
- `gender`
- `gender_probability`
- `sample_size`
- `age`
- `age_group`
- `country_id`
- `country_probability`
- `created_at` (UTC ISO 8601)

Names are normalized to lowercase before lookup and storage, so `Ella` and `ella` map to the same profile.

## API

### `POST /api/profiles`

Creates a profile from a request body such as:

```json
{
  "name": "ella"
}
```

- Returns `201 Created` with the full stored profile on first creation.
- Returns `200 OK` with `message: "Profile already exists"` if the normalized name is already stored.

### `GET /api/profiles/:id`

Returns the full stored profile for a single UUID.

### `GET /api/profiles`

Returns a summary list of stored profiles.

Optional case-insensitive query parameters:

- `gender`
- `country_id`
- `age_group`

Example:

```txt
/api/profiles?gender=male&country_id=ng
```

### `DELETE /api/profiles/:id`

Deletes a stored profile and returns `204 No Content`.

## Error responses

All API errors use:

```json
{
  "status": "error",
  "message": "..."
}
```

Implemented cases:

- `400 Bad Request`: missing or empty `name`
- `422 Unprocessable Entity`: invalid input type
- `404 Not Found`: profile not found
- `502 Bad Gateway`: invalid upstream API response
- `500 Internal Server Error`: unexpected server failure

Upstream validation messages are:

- `Genderize returned an invalid response`
- `Agify returned an invalid response`
- `Nationalize returned an invalid response`

## Notes

- CORS is enabled with `Access-Control-Allow-Origin: *`.
- Nationality is chosen from the highest-probability country in the Nationalize response.
- Age groups follow the assessment rules: `child`, `teenager`, `adult`, `senior`.
