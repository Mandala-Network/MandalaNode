import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
    await knex.schema.alterTable('deploys', table => {
        table.string('service_name', 255).nullable();
    });
    await knex.schema.alterTable('projects', table => {
        table.text('service_links').nullable();
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.alterTable('deploys', table => {
        table.dropColumn('service_name');
    });
    await knex.schema.alterTable('projects', table => {
        table.dropColumn('service_links');
    });
}
