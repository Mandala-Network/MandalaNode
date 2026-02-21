import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
    await knex.schema.alterTable('projects', table => {
        table.text('agent_config').nullable();
        table.boolean('requires_blockchain_funding').defaultTo(false);
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.alterTable('projects', table => {
        table.dropColumn('agent_config');
        table.dropColumn('requires_blockchain_funding');
    });
}
