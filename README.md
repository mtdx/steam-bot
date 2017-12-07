## Getting Started

These instructions will guide you through setting up a developer workspace. 

1. Ensure that you are using at least LTS version of NodeJS:

  ```bash
  $ node --version
  v8.9.2
  ```

2. Clone the repository to your local system:

  ```bash
  $ git clone git@github.com:mtdx/steam-bot.git
  ```

3. Install dependencies using `npm`:

  ```bash
  $ cd steam-bot
  $ npm install
  ```

4. Install and configure PostgreSQL:

    - Install version 10.x of PostgreSQL - these steps will depend on your operating system

    - Create a PostgreSQL user and database:

      ```bash
      $ psql
      > CREATE USER steambot WITH PASSWORD 'password';
      > CREATE DATABASE steambot;
      > GRANT ALL PRIVILEGES ON DATABASE steambot TO steambot;
      ```

5. Initialize database schema:

  ```bash
  $ cd api
  $ $(npm bin)/knex migrate:latest
  ```

6. Start the Bot Server:
  ```bash
  $ npm run start-dev
  ```