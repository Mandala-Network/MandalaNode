import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable('tee_attestations', table => {
        table.increments('id').primary();
        table.string('attestation_txid', 64).notNullable().unique();
        table.string('node_identity_key', 66).notNullable();
        table.string('tee_public_key', 66).notNullable();
        table.string('tdx_quote_hash', 64).notNullable();
        table.string('mr_enclave', 96).notNullable();
        table.string('mr_signer', 96).notNullable();
        table.string('gpu_evidence_hash', 64).nullable();
        table.string('tee_technology', 16).notNullable();
        table.boolean('is_current').notNullable().defaultTo(false);
        table.timestamp('attested_at').notNullable();
        table.timestamp('created_at').defaultTo(knex.fn.now());
        table.index(['node_identity_key', 'is_current']);
    });

    await knex.schema.createTable('inference_receipt_batches', table => {
        table.increments('id').primary();
        table.string('batch_txid', 64).notNullable().unique();
        table.string('merkle_root', 64).notNullable();
        table.integer('receipt_count').notNullable();
        table.string('node_identity_key', 66).notNullable();
        table.string('attestation_txid', 64).notNullable();
        table.timestamp('created_at').defaultTo(knex.fn.now());
    });

    await knex.schema.alterTable('projects', table => {
        table.boolean('tee_required').notNullable().defaultTo(false);
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists('inference_receipt_batches');
    await knex.schema.dropTableIfExists('tee_attestations');
    await knex.schema.alterTable('projects', table => {
        table.dropColumn('tee_required');
    });
}
