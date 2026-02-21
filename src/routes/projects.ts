import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import logger from '../logger';
import type { Knex } from 'knex';
import { Utils, WalletInterface } from '@bsv/sdk';
import { execSync } from 'child_process';
import dns from 'dns/promises';
import { sendAdminNotificationEmail, sendWelcomeEmail, sendDomainChangeEmail } from '../utils/email';
import { enableIngress } from '../utils/ingress';

const router = Router();

const VALID_LOG_PERIODS = ['5m', '15m', '30m', '1h', '2h', '6h', '12h', '1d', '2d', '7d'] as const;
const VALID_LOG_LEVELS = ['all', 'error', 'warn', 'info'] as const;
const MAX_TAIL_LINES = 10000;

type LogPeriod = typeof VALID_LOG_PERIODS[number];
type LogLevel = typeof VALID_LOG_LEVELS[number];

function isValidLogPeriod(period: string): period is LogPeriod {
    return VALID_LOG_PERIODS.includes(period as LogPeriod);
}

function isValidLogLevel(level: string): level is LogLevel {
    return VALID_LOG_LEVELS.includes(level as LogLevel);
}

function sanitizeTailValue(tail: number): number {
    return Math.min(Math.max(1, Math.floor(tail)), MAX_TAIL_LINES);
}

/**
 * Middleware to ensure user is registered
 */
async function requireRegisteredUser(req: Request, res: Response, next: Function) {
    const { db }: { db: Knex } = req as any;
    const identityKey = (req as any).auth.identityKey;
    const user = await db('users').where({ identity_key: identityKey }).first();
    if (!user) {
        logger.warn({ identityKey }, 'User not registered');
        return res.status(401).json({ error: 'User not registered' });
    }
    (req as any).user = user;
    next();
}

/**
 * Check project existence
 */
async function requireProject(req: Request, res: Response, next: Function) {
    const { db }: { db: Knex } = req as any;
    const { projectId } = req.params;
    const project = await db('projects').where({ project_uuid: projectId }).first();
    if (!project) {
        logger.warn({ projectId }, 'Project not found');
        return res.status(404).json({ error: 'Project not found' });
    }
    (req as any).project = project;
    next();
}

/**
 * Check if user is project admin
 */
async function requireProjectAdmin(req: Request, res: Response, next: Function) {
    const { db }: { db: Knex } = req as any;
    const identityKey = (req as any).auth.identityKey;
    const project = (req as any).project;

    const admin = await db('project_admins').where({ project_id: project.id, identity_key: identityKey }).first();
    if (!admin) {
        logger.warn({ identityKey, projectId: project.project_uuid }, 'User is not admin of project');
        return res.status(403).json({ error: 'User not admin' });
    }
    next();
}

async function requireDeployment(req: Request, res: Response, next: Function) {
    const { db }: { db: Knex } = req as any;
    const { deploymentId, projectId } = req.params;
    const deploy = await db('deploys').where({ deployment_uuid: deploymentId }).first();
    if (!deploy) {
        return res.status(404).json({ error: 'Deploy not found' });
    }
    const project = await db('projects').where({ id: deploy.project_id }).first();
    if (!project || project.project_uuid !== projectId) {
        return res.status(404).json({ error: 'Project not found for the given deployment' });
    }
    (req as any).deploy = deploy;
    (req as any).project = project;
    next();
}

async function requireProjectAdminForDeploy(req: Request, res: Response, next: Function) {
    const { db }: { db: Knex } = req as any;
    const identityKey = (req as any).auth.identityKey;
    const deploy = (req as any).deploy;

    const admin = await db('project_admins').where({ project_id: deploy.project_id, identity_key: identityKey }).first();
    if (!admin) {
        return res.status(403).json({ error: 'Not admin of project' });
    }
    next();
}

/**
 * Create a new project
 * @body { name: string, network?: 'testnet'|'mainnet', privateKey?: string, requiresBlockchainFunding?: boolean }
 */
router.post('/create', requireRegisteredUser, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const identityKey = (req as any).auth.identityKey;
    let { name, network, privateKey, requiresBlockchainFunding } = req.body;
    const projectId = crypto.randomBytes(16).toString('hex');

    execSync(`kubectl create namespace mandala-project-${projectId} || true`, { stdio: 'inherit' });
    logger.info(`Namespace mandala-project-${projectId} ensured.`);

    // Generate a private key for the project if not provided
    if (!privateKey) {
        privateKey = crypto.randomBytes(32).toString('hex');
    } else {
        // Validate the provided private key: must be 64 lowercase hex characters
        if (!/^[0-9a-f]{64}$/.test(privateKey)) {
            return res.status(400).json({ error: 'Invalid private key' });
        }
    }

    const [projId] = await db('projects').insert({
        project_uuid: projectId,
        name: name || 'Unnamed Project',
        balance: 0,
        network: network === 'testnet' ? 'testnet' : 'mainnet',
        private_key: privateKey,
        agent_config: '{}',
        requires_blockchain_funding: requiresBlockchainFunding || false
    }, ['id']).returning('id');

    await db('project_admins').insert({
        project_id: projId,
        identity_key: identityKey
    });

    await db('logs').insert({
        project_id: projId.id,
        message: 'Project created'
    });

    logger.info({ projectId, name }, 'Project created');
    res.json({ projectId, message: 'Project created' });
});

/**
 * Pay (add funds) to a project
 * @body { amount: number } - Amount in satoshis to add
 */
router.post('/:projectId/pay', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;
    const { amount } = req.body;

    if (typeof amount !== 'number' || amount <= 0) {
        return res.status(400).json({ error: 'Invalid amount. Must be a positive number.' });
    }

    const oldBalance = Number(project.balance);
    const newBalance = oldBalance + amount;
    await db('projects').where({ id: project.id }).update({ balance: newBalance });

    // Insert accounting record (credit)
    const metadata = { reason: 'Admin payment' };
    await db('project_accounting').insert({
        project_id: project.id,
        type: 'credit',
        amount_sats: amount,
        balance_after: newBalance,
        metadata: JSON.stringify(metadata)
    });

    await db('logs').insert({
        project_id: project.id,
        message: `Balance increased by ${amount}. New balance: ${newBalance}`
    });

    // If balance was negative and now is >=0, re-enable ingress
    if (oldBalance < 0 && newBalance >= 0) {
        const enabled = await enableIngress(project.project_uuid);
        if (enabled) {
            await db('logs').insert({
                project_id: project.id,
                message: `Ingress re-enabled after payment. Balance: ${newBalance}`
            });
        } else {
            await db('logs').insert({
                project_id: project.id,
                message: `Unable to re-enable ingress after payment, project needs to be redeployed.`
            });
        }
    }

    res.json({ message: `Paid ${amount} sats. New balance: ${newBalance}` });
});

/**
 * List projects where user is admin.
 */
router.post('/list', requireRegisteredUser, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const identityKey = (req as any).auth.identityKey;

    const projects = await db('projects')
        .join('project_admins', 'projects.id', 'project_admins.project_id')
        .where('project_admins.identity_key', identityKey)
        .select('projects.project_uuid as id', 'projects.name', 'projects.network', 'projects.balance', 'projects.created_at');

    res.json({ projects });
});

/**
 * Helper to resolve a user by identityKey or email
 */
async function resolveUser(db: Knex, identityOrEmail: string) {
    let user = await db('users').where({ identity_key: identityOrEmail }).first();
    if (!user && identityOrEmail.includes('@')) {
        user = await db('users').where({ email: identityOrEmail }).first();
    }
    return user;
}

/**
 * Add Admin to a project
 * @body { identityKeyOrEmail: string }
 */
router.post('/:projectId/addAdmin', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;
    const user = (req as any).user;
    const { identityKeyOrEmail } = req.body;

    const targetUser = await resolveUser(db, identityKeyOrEmail);
    if (!targetUser) {
        return res.status(400).json({ error: 'Target user not registered' });
    }

    const existing = await db('project_admins').where({ project_id: project.id, identity_key: targetUser.identity_key }).first();
    if (!existing) {
        await db('project_admins').insert({ project_id: project.id, identity_key: targetUser.identity_key });
        await db('logs').insert({
            project_id: project.id,
            message: `Admin added: ${targetUser.identity_key}`
        });

        const admins = await db('project_admins')
            .join('users', 'users.identity_key', 'project_admins.identity_key')
            .where({ 'project_admins.project_id': project.id })
            .select('users.email', 'users.identity_key');

        const emails = admins.map((a: any) => a.email);
        const subject = `Admin Added to Project: ${project.name}`;
        const body = `Hello,

User ${targetUser.identity_key} (${targetUser.email}) has been added as an admin to project "${project.name}" (ID: ${project.project_uuid}).

Originated by: ${user.identity_key} (${user.email})

Regards,
Mandala Network`;

        await sendAdminNotificationEmail(emails, project, body, subject);

        const welcomeSubject = `You have been added as an admin to: ${project.name}`;
        const welcomeBody = `Hello,

You have been added as an admin to project "${project.name}" (ID: ${project.project_uuid}).

Originated by: ${user.identity_key} (${user.email})

Regards,
Mandala Network`;

        await sendWelcomeEmail(targetUser.email, project, welcomeBody, welcomeSubject);

        return res.json({ message: 'Admin added' });
    } else {
        return res.json({ message: 'User is already an admin' });
    }
});

/**
 * Remove Admin from a project
 * @body { identityKeyOrEmail: string }
 */
router.post('/:projectId/removeAdmin', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;
    const user = (req as any).user;
    const { identityKeyOrEmail } = req.body;

    const targetUser = await resolveUser(db, identityKeyOrEmail);
    if (!targetUser) {
        return res.status(400).json({ error: 'Target user not registered' });
    }

    const admins = await db('project_admins').where({ project_id: project.id });
    if (admins.length === 1 && admins[0].identity_key === targetUser.identity_key) {
        return res.status(400).json({ error: 'Cannot remove last admin' });
    }

    const existing = admins.find(a => a.identity_key === targetUser.identity_key);
    if (!existing) {
        return res.status(400).json({ error: 'User not an admin' });
    }

    await db('project_admins').where({ project_id: project.id, identity_key: targetUser.identity_key }).del();
    await db('logs').insert({
        project_id: project.id,
        message: `Admin removed: ${targetUser.identity_key}`
    });

    const adminList = await db('project_admins')
        .join('users', 'users.identity_key', 'project_admins.identity_key')
        .where({ 'project_admins.project_id': project.id })
        .select('users.email');

    const emails = adminList.map((a: any) => a.email);
    const subject = `Admin Removed from Project: ${project.name}`;
    const body = `Hello,

User ${targetUser.identity_key} (${targetUser.email}) has been removed as an admin from project "${project.name}" (ID: ${project.project_uuid}).

Originated by: ${user.identity_key} (${user.email})

Regards,
Mandala Network`;

    await sendAdminNotificationEmail(emails, project, body, subject);

    res.json({ message: 'Admin removed' });
});

/**
 * List admins for a project
 */
router.post('/:projectId/admins/list', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;

    const admins = await db('project_admins')
        .join('users', 'users.identity_key', 'project_admins.identity_key')
        .where({ project_id: project.id })
        .select('project_admins.identity_key', 'users.email', 'project_admins.added_at');

    res.json({ admins });
});

/**
 * List deployments for a project
 */
router.post('/:projectId/deploys/list', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;

    const deploys = await db('deploys').where({ project_id: project.id }).select('deployment_uuid', 'created_at');
    res.json({ deploys });
});

/**
 * Create a new deploy for a project
 * @returns { deploymentId, url } - URL for uploading release files.
 */
router.post('/:projectId/deploy', requireRegisteredUser, async (req: Request, res: Response) => {
    const { db, mainnetWallet: wallet }: { db: Knex, mainnetWallet: WalletInterface } = req as any;
    const { projectId } = req.params;
    const identityKey = (req as any).auth.identityKey;

    const project = await db('projects').where({ project_uuid: projectId }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const admin = await db('project_admins').where({ project_id: project.id, identity_key: identityKey }).first();
    if (!admin) return res.status(403).json({ error: 'Not admin of project' });

    const deploymentId = crypto.randomBytes(16).toString('hex');

    const [depId] = await db('deploys').insert({
        deployment_uuid: deploymentId,
        project_id: project.id,
        creator_identity_key: identityKey
    }, ['id']).returning('id');

    await db('logs').insert({
        project_id: project.id,
        deploy_id: depId,
        message: 'Deployment started'
    });

    const { signature } = await wallet.createSignature({
        data: Utils.toArray(deploymentId, 'hex'),
        protocolID: [2, 'url signing'],
        keyID: deploymentId,
        counterparty: 'self'
    });

    const uploadUrl = `${process.env.MANDALA_NODE_SERVER_BASEURL || 'http://localhost:7777'}/api/v1/upload/${deploymentId}/${Utils.toHex(signature)}`;
    res.json({
        url: uploadUrl,
        deploymentId,
        message: 'Deployment created'
    });
});

/**
 * Update agent config for a project
 * @body { config: object }
 */
router.post('/:projectId/agent/config', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;
    const { config } = req.body;

    if (!config || typeof config !== 'object') {
        return res.status(400).json({ error: 'Invalid config - must be an object' });
    }

    try {
        JSON.stringify(config);
        await db('projects')
            .where({ id: project.id })
            .update({ agent_config: JSON.stringify(config) });

        await db('logs').insert({
            project_id: project.id,
            message: 'Agent config updated'
        });

        res.json({ message: 'Agent config updated' });
    } catch (error) {
        return res.status(400).json({ error: 'Invalid config - must be JSON serializable' });
    }
});

/**
 * Get project info
 */
router.post('/:projectId/info', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const project = (req as any).project;

    try {
        const namespace = `mandala-project-${project.project_uuid}`;
        const status = {
            online: false,
            lastChecked: new Date(),
            domains: { ssl: false } as { frontend?: string; agent?: string; ssl: boolean },
            deploymentId: null as string | null
        };

        try {
            const podsOutput = execSync(`kubectl get pods -n ${namespace} -o json`);
            const pods = JSON.parse(podsOutput.toString());

            // Identify agent pod
            const agentPod = pods.items.find((pod: any) =>
                pod.metadata.labels?.app === `mandala-project-${project.project_uuid.substr(0, 24)}`
            );
            if (agentPod) {
                const agentContainer = agentPod.spec.containers.find((c: any) => c.name === 'agent');
                if (agentContainer) {
                    const imageTag = agentContainer.image.split(':')[1];
                    status.deploymentId = imageTag;
                }
            }

            // Check if all pods are running and ready
            status.online = pods.items.length > 0 && pods.items.every((pod: any) =>
                pod.status.phase === 'Running' &&
                pod.status.containerStatuses?.every((container: any) => container.ready)
            );

            // Get ingress info
            try {
                const ingressOutput = execSync(`kubectl get ingress -n ${namespace} -o json`);
                const ingress = JSON.parse(ingressOutput.toString());

                ingress.items.forEach((ing: any) => {
                    if (!ing.spec.rules) return;
                    ing.spec.rules.forEach((rule: any) => {
                        const host = rule.host;
                        if (host.startsWith('frontend.')) {
                            status.domains.frontend = host;
                        } else if (host.startsWith('agent.')) {
                            status.domains.agent = host;
                        }
                    });
                    status.domains.ssl = ing.spec.tls?.length > 0;
                });
            } catch (ignore) {
                // ingress might be disabled
            }

        } catch (error: any) {
            logger.error({ error: error.message }, 'Error checking project status');
        }

        const billingInfo = {
            balance: Number(project.balance)
        };

        const customDomains = {
            frontend: project.frontend_custom_domain || null,
            agent: project.backend_custom_domain || null
        };

        const agentConfig = project.agent_config ? JSON.parse(project.agent_config) : null;

        res.json({
            id: project.project_uuid,
            name: project.name,
            network: project.network,
            status,
            billing: billingInfo,
            sslEnabled: status.domains.ssl,
            customDomains,
            agentConfig,
            requiresBlockchainFunding: project.requires_blockchain_funding
        });
    } catch (error: any) {
        logger.error({ error: error.message }, 'Error getting project info');
        res.status(500).json({ error: 'Failed to get project info' });
    }
});

/**
 * Delete project endpoint
 */
router.post('/:projectId/delete', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;
    const user = (req as any).user;

    const namespace = `mandala-project-${project.project_uuid}`;
    const helmReleaseName = `mandala-project-${project.project_uuid.substr(0, 24)}`;

    // Uninstall helm release
    try {
        execSync(`helm uninstall ${helmReleaseName} -n ${namespace}`, { stdio: 'inherit' });
    } catch (e) {
        logger.warn({ project_uuid: project.project_uuid }, 'Helm uninstall failed or not found. Continuing.');
    }

    // Delete namespace
    try {
        execSync(`kubectl delete namespace ${namespace}`, { stdio: 'inherit' });
    } catch (e) {
        logger.warn({ project_uuid: project.project_uuid }, 'Namespace deletion failed or not found. Continuing.');
    }

    // Gather admins
    const admins = await db('project_admins')
        .join('users', 'users.identity_key', 'project_admins.identity_key')
        .where({ 'project_admins.project_id': project.id })
        .select('users.email', 'users.identity_key');

    const emails = admins.map((a: any) => a.email);

    const subject = `Project Deleted: ${project.name}`;
    const body = `Hello,

Project "${project.name}" (ID: ${project.project_uuid}) has been deleted.

Originated by: ${user.identity_key} (${user.email})

All resources have been removed.

Regards,
Mandala Network`;

    await sendAdminNotificationEmail(emails, project, body, subject);

    // Delete from DB
    await db('project_accounting').where({ project_id: project.id }).del();
    await db('deploys').where({ project_id: project.id }).del();
    await db('project_admins').where({ project_id: project.id }).del();
    await db('logs').where({ project_id: project.id }).del();
    await db('projects').where({ id: project.id }).del();

    res.json({ message: 'Project deleted' });
});

/**
 * Project billing stats endpoint.
 */
router.post('/:projectId/billing/stats', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;

    const { type, start, end } = req.body;

    let query = db('project_accounting').where({ project_id: project.id });

    if (type && ['debit', 'credit'].includes(type)) {
        query = query.andWhere({ type });
    }

    if (start) {
        query = query.andWhere('timestamp', '>=', new Date(start));
    }

    if (end) {
        query = query.andWhere('timestamp', '<=', new Date(end));
    }

    const records = await query.orderBy('timestamp', 'desc').select('*');

    res.json({ records });
});

/**
 * PROJECT LOGS (SYSTEM-LEVEL)
 */
router.post('/:projectId/logs/project', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;

    const logs = await db('logs')
        .where({ project_id: project.id })
        .whereNull('deploy_id')
        .orderBy('timestamp', 'asc');

    const joinedLogs = logs.map(l => `[${l.timestamp}] ${l.message}`).join('\n');
    res.json({ logs: joinedLogs });
});

/**
 * DEPLOYMENT LOGS
 */
router.post('/:projectId/logs/deployment/:deploymentId', requireRegisteredUser, requireProject, requireDeployment, requireProjectAdminForDeploy, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const deploy = (req as any).deploy;

    const logs = await db('logs')
        .where({ deploy_id: deploy.id })
        .orderBy('timestamp', 'asc');

    const joinedLogs = logs.map(l => `[${l.timestamp}] ${l.message}`).join('\n');
    res.json({ logs: joinedLogs });
});

/**
 * RESOURCE LOGS (CLUSTER-LEVEL)
 * Supported resources: 'frontend', 'agent', 'mongo', 'mysql', 'redis'
 */
router.post('/:projectId/logs/resource/:resource', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const project = (req as any).project;
    const { resource } = req.params;
    const { since = '1h', tail = 1000, level = 'all' } = req.body;

    if (!['frontend', 'agent', 'mongo', 'mysql', 'redis'].includes(resource)) {
        return res.status(400).json({ error: 'Invalid resource type' });
    }

    if (!isValidLogPeriod(since)) {
        return res.status(400).json({
            error: 'Invalid time period',
            validPeriods: VALID_LOG_PERIODS
        });
    }

    if (!isValidLogLevel(level)) {
        return res.status(400).json({
            error: 'Invalid log level',
            validLevels: VALID_LOG_LEVELS
        });
    }

    const sanitizedTail = sanitizeTailValue(tail);

    try {
        const namespace = `mandala-project-${project.project_uuid}`;
        const podsOutput = execSync(`kubectl get pods -n ${namespace} -o json`);
        const pods = JSON.parse(podsOutput.toString());

        if (!pods.items?.length) {
            return res.status(404).json({ error: `No ${resource} pods found, are things finished deploying?` });
        }

        let logs;
        let podName;

        if (resource === 'mysql' || resource === 'mongo' || resource === 'redis') {
            podName = resource === 'redis' ? undefined : `${resource}-0`;

            if (resource === 'redis') {
                // Redis is a Deployment, not StatefulSet
                const pod = pods.items.find(p => p.metadata.name.startsWith('redis-'));
                if (!pod) {
                    return res.status(404).json({ error: `No logs found for ${resource}` });
                }
                podName = pod.metadata.name;
            } else {
                const pod = pods.items.find(p => p.metadata.name === podName);
                if (!pod) {
                    return res.status(404).json({ error: `No logs found for ${resource}, does your project have it and is it deployed?` });
                }
            }

            const cmd = `kubectl logs -n ${namespace} ${podName} --since=${since} --tail=${sanitizedTail}`;
            logs = execSync(cmd).toString();
        } else {
            // For frontend and agent, find the main deployment pod
            const pod = pods.items.find(x => x.metadata.name.startsWith('mandala-project-'));
            if (!pod) {
                return res.status(404).json({ error: `No pod found for ${resource}` });
            }
            podName = pod.metadata.name;

            const container = pod.spec.containers.find(c => c.name === resource);
            if (!container) {
                return res.status(404).json({ error: `No container ${resource} found in pod ${podName}` });
            }

            const cmd = `kubectl logs -n ${namespace} ${podName} -c ${resource} --since=${since} --tail=${sanitizedTail}`;
            logs = execSync(cmd).toString();
        }

        // Filter logs by level if required
        let filteredLogs = logs;
        if (level !== 'all') {
            const levelPattern = new RegExp(`\\b${level.toUpperCase()}\\b`, 'i');
            filteredLogs = logs
                .split('\n')
                .filter(line => levelPattern.test(line))
                .join('\n');
        }

        res.json({
            resource,
            logs: filteredLogs,
            metadata: {
                since,
                tail: sanitizedTail,
                level
            }
        });
    } catch (error: any) {
        logger.error({ error: error.message }, 'Error getting resource logs');
        res.status(500).json({ error: 'Failed to get resource logs' });
    }
});

/**
 * Custom domain verification and setup
 */
async function handleCustomDomain(
    req: Request,
    res: Response,
    domainType: 'frontend' | 'agent'
) {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;
    const user = (req as any).user;

    const { domain } = req.body;
    if (!domain || typeof domain !== 'string' || !domain.match(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/)) {
        return res.status(400).json({ error: 'Invalid domain format. Please provide a valid domain (e.g. example.com)' });
    }

    const expectedRecord = `mandala-project-verification=${project.project_uuid}:${domainType}`;
    const verificationHost = `mandala_project.${domain}`;

    try {
        const txtRecords = await dns.resolveTxt(verificationHost);
        const found = txtRecords.some(recordSet => recordSet.includes(expectedRecord));
        if (!found) {
            const instructions = `Please create a DNS TXT record at:\n\n  ${verificationHost}\n\nWith the exact value:\n\n  ${expectedRecord}\n\nOnce this TXT record is in place, please try again.`;
            return res.status(400).json({ error: 'DNS verification failed', instructions });
        }

        const updateField = domainType === 'frontend' ? 'frontend_custom_domain' : 'backend_custom_domain';
        await db('projects')
            .where({ id: project.id })
            .update({ [updateField]: domain });

        await db('logs').insert({
            project_id: project.id,
            message: `${domainType.charAt(0).toUpperCase() + domainType.slice(1)} custom domain set: ${domain}`
        });

        const admins = await db('project_admins')
            .join('users', 'users.identity_key', 'project_admins.identity_key')
            .where({ 'project_admins.project_id': project.id })
            .select('users.email');

        const emails = admins.map((a: any) => a.email);
        const subject = `Custom Domain Updated for Project: ${project.name}`;
        const body = `Hello,

The ${domainType} custom domain for project "${project.name}" (ID: ${project.project_uuid}) has been set to: ${domain}

Originated by: ${user.identity_key} (${user.email})

Regards,
Mandala Network`;

        await sendDomainChangeEmail(emails, project, body, subject);

        return res.json({ message: `${domainType.charAt(0).toUpperCase() + domainType.slice(1)} custom domain verified and set`, domain });
    } catch (err: any) {
        logger.error({ err: err.message }, 'Error during DNS verification process');
        const instructions = `Please ensure that DNS is functioning and that you create a TXT record:\n\n  ${verificationHost}\n\nWith the value:\n\n  ${expectedRecord}\n\nThen try again.`;
        return res.status(400).json({ error: 'Failed to verify domain', instructions });
    }
}

router.post('/:projectId/domains/frontend', requireRegisteredUser, requireProject, requireProjectAdmin, (req: Request, res: Response) => {
    return handleCustomDomain(req, res, 'frontend');
});

router.post('/:projectId/domains/agent', requireRegisteredUser, requireProject, requireProjectAdmin, (req: Request, res: Response) => {
    return handleCustomDomain(req, res, 'agent');
});

/**
 * Update agent settings for this project.
 * @body { env?: Record<string,string>, requiresBlockchainFunding?: boolean }
 */
router.post('/:projectId/settings/update', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;

    const { env, requiresBlockchainFunding } = req.body;

    // Load existing agent_config
    let agentConfig: any;
    try {
        agentConfig = project.agent_config ? JSON.parse(project.agent_config) : {};
    } catch (e) {
        agentConfig = {};
    }

    // Merge env updates
    if (env && typeof env === 'object') {
        agentConfig = { ...agentConfig, ...env };
    }

    const updates: any = {
        agent_config: JSON.stringify(agentConfig)
    };

    if (typeof requiresBlockchainFunding === 'boolean') {
        updates.requires_blockchain_funding = requiresBlockchainFunding;
    }

    await db('projects').where({ id: project.id }).update(updates);

    await db('logs').insert({
        project_id: project.id,
        message: 'Agent settings updated'
    });

    return res.json({ message: 'Agent settings updated successfully', agentConfig });
});

/**
 * Admin route: Restart agent deployment
 */
router.post('/:projectId/admin/restart', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const project = (req as any).project;

    try {
        const namespace = `mandala-project-${project.project_uuid}`;
        const helmReleaseName = `mandala-project-${project.project_uuid.substr(0, 24)}`;
        execSync(`kubectl rollout restart deployment/${helmReleaseName}-deployment -n ${namespace}`, { stdio: 'inherit' });
        res.json({ message: 'Agent restart initiated' });
    } catch (error: any) {
        logger.error({ error: error.message }, 'Error restarting agent');
        res.status(500).json({ error: 'Failed to restart agent' });
    }
});

/**
 * Admin route: Get agent deployment status
 */
router.post('/:projectId/admin/status', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const project = (req as any).project;

    try {
        const namespace = `mandala-project-${project.project_uuid}`;
        const podsOutput = execSync(`kubectl get pods -n ${namespace} -o json`);
        const pods = JSON.parse(podsOutput.toString());

        const podStatuses = pods.items.map((pod: any) => ({
            name: pod.metadata.name,
            phase: pod.status.phase,
            ready: pod.status.containerStatuses?.every((c: any) => c.ready) || false,
            containers: pod.spec.containers.map((c: any) => c.name),
            restartCount: pod.status.containerStatuses?.reduce((sum: number, c: any) => sum + (c.restartCount || 0), 0) || 0
        }));

        res.json({ pods: podStatuses });
    } catch (error: any) {
        logger.error({ error: error.message }, 'Error getting agent status');
        res.status(500).json({ error: 'Failed to get agent status' });
    }
});

/**
 * Helper for constructing the agent domain for the project
 */
export function getBackendDomain(project: any) {
    const projectsDomain = process.env.PROJECT_DEPLOYMENT_DNS_NAME!;
    return project.backend_custom_domain || `agent.${project.project_uuid}.${projectsDomain}`;
}

export default router;
