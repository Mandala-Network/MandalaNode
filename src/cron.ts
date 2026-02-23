import { CronJob } from 'cron';
import { checkAndFundProjectKeys } from './utils/wallet';
import logger from './logger';
import type { Knex } from 'knex';
import { checkAndIssueCertificates } from './utils/SSLManager';
import { billProjects } from './utils/billing';
import { publishNodeAdvertisement } from './utils/registry';
import { WalletInterface } from '@bsv/sdk';

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

    logger.info('Cron jobs started');
}
