import { CronJob } from 'cron';
import { checkAndFundProjectKeys } from './utils/wallet';
import logger from './logger';
import type { Knex } from 'knex';
import { checkAndIssueCertificates } from './utils/SSLManager';
import { billProjects } from './utils/billing';
import { publishNodeAdvertisement } from './utils/registry';
import { WalletInterface } from '@bsv/sdk';

const TEE_ENABLED = process.env.TEE_ENABLED === 'true';
const ATTESTATION_MAX_AGE_HOURS = 6;

export function startCronJobs(db: Knex, mainnetWallet: WalletInterface, testnetWallet: WalletInterface) {
    // Check project keys every 5 minutes
    new CronJob(
        '*/5 * * * *',
        async () => {
            logger.info('Running cron jobs')
            try {
                await checkAndFundProjectKeys(db, mainnetWallet, testnetWallet);
            } catch (error) {
                logger.error({ err: error }, 'Error in project keys cron job');
            }
            try {
                await checkAndIssueCertificates();
            } catch (error) {
                logger.error({ err: error }, 'Error in SSL certificates cron job');
            }
            try {
                await billProjects();
            } catch (error) {
                logger.error({ err: error }, 'Error in project billing cron job');
            }
        },
        null,
        true
    );

    // Publish node advertisement to BSV overlay every 30 minutes
    if (process.env.REGISTRY_ENABLED !== 'false') {
        new CronJob(
            '*/30 * * * *',
            async () => {
                try {
                    await publishNodeAdvertisement(mainnetWallet);
                    logger.info('Published node advertisement to overlay');
                } catch (e) {
                    logger.error(e, 'Failed to publish node advertisement');
                }
            },
            null,
            true
        );
    }

    // Check TEE attestation freshness every 6 hours
    if (TEE_ENABLED) {
        new CronJob(
            '0 */6 * * *',
            async () => {
                try {
                    const currentAttestation = await db('tee_attestations')
                        .where({ is_current: true })
                        .first();
                    if (currentAttestation) {
                        const attestedAt = new Date(currentAttestation.attested_at);
                        const ageHours = (Date.now() - attestedAt.getTime()) / (1000 * 60 * 60);
                        if (ageHours > ATTESTATION_MAX_AGE_HOURS) {
                            logger.warn(
                                { attestationTxid: currentAttestation.attestation_txid, ageHours: Math.round(ageHours) },
                                'TEE attestation is stale — CVM proxy should re-attest'
                            );
                            // The CVM proxy handles re-attestation itself since it owns the TEE key
                            // and has direct access to tappd. We just log the staleness here.
                        }
                    } else {
                        logger.warn('No current TEE attestation found');
                    }
                } catch (e) {
                    logger.error(e, 'Error checking TEE attestation freshness');
                }
            },
            null,
            true
        );
    }

    logger.info('Cron jobs started');
}
