import Knex from 'knex';

const knexConfig = {
    client: 'mysql2',
    connection: process.env.MYSQL_DATABASE_URL || {
        host: 'localhost',
        user: 'mandala_user',
        password: 'mandala_pass',
        database: 'mandala_db'
    },
    migrations: {
        directory: './src/migrations'
    }
};

const db = Knex(knexConfig);

export default db;
