# DockerDonut

A TypeScript monorepo with a Next.js frontend and an Express API.

## Requirements

- Node.js 20.9 or later
- npm 10 or later

## Getting started

Install dependencies from the repository root:

```bash
npm install
```

Configure the API before starting it:

1. Copy `apps/api/.env.example` to `apps/api/.env`.
2. Set `AUTH_SECRET` to a unique random value of at least 32 characters.
3. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` to seed the first admin account.
   The password must have at least 8 characters. Admin credentials are read
   from the environment, and passwords are stored as bcrypt hashes.

Start the frontend and API together:

```bash
npm run dev
```

- Frontend: http://localhost:3000
- API health check: http://localhost:4000/api/health

You can also run either workspace separately with `npm run dev:web` or
`npm run dev:api`.

## Starter features

- Public username/password registration and sign-in; there is no email verification.
- An admin account seeded from environment variables.
- Admin tools to create subject sections and add timed or untimed mock tests.
- Question entry using JSON in the admin form, or JSON/CSV file import.
- Single-choice, multi-select, and written questions.
- Student attempts, automatic scoring for choice questions, and attempt analytics.
- SQLite persistence at `apps/api/data/app.db` by default. Override with `DB_PATH`.

Written answers are saved with the attempt but are not automatically graded or
included in the score. CSV files must have the headers `type,prompt,options,correctAnswers,points`;
separate option/answer values with `|`. For written questions, leave the
`options` and `correctAnswers` fields empty. JSON files can be an array of
questions or an object containing a `questions` array, for example:

```json
[
  {
    "type": "single",
    "prompt": "What is 2 + 2?",
    "options": ["3", "4", "5"],
    "correctAnswers": ["4"],
    "points": 1
  },
  {
    "type": "written",
    "prompt": "Explain your approach.",
    "points": 3
  }
]
```

## Workspaces

- `apps/web` — Next.js App Router frontend
- `apps/api` — Express API server
