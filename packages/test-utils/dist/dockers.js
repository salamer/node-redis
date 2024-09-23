"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.spawnRedisCluster = exports.spawnRedisServer = void 0;
const net_1 = require("net");
const events_1 = require("events");
const client_1 = require("@redis/client/dist/lib/client");
const utils_1 = require("@redis/client/dist/lib/utils");
const path = require("path");
const util_1 = require("util");
const child_process_1 = require("child_process");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
async function isPortAvailable(port) {
    try {
        const socket = (0, net_1.createConnection)({ port });
        await (0, events_1.once)(socket, 'connect');
        socket.end();
    }
    catch (err) {
        if (err instanceof Error && err.code === 'ECONNREFUSED') {
            return true;
        }
    }
    return false;
}
const portIterator = (async function* () {
    for (let i = 6379; i < 65535; i++) {
        if (await isPortAvailable(i)) {
            yield i;
        }
    }
    throw new Error('All ports are in use');
})();
// ".." cause it'll be in `./dist`
const DOCKER_FODLER_PATH = path.join(__dirname, '../docker');
async function spawnRedisServerDocker({ image, version }, serverArguments) {
    const port = (await portIterator.next()).value, { stdout, stderr } = await execAsync('docker run -d --network host $(' +
        `docker build ${DOCKER_FODLER_PATH} -q ` +
        `--build-arg IMAGE=${image}:${version} ` +
        `--build-arg REDIS_ARGUMENTS="--save '' --port ${port.toString()} ${serverArguments.join(' ')}"` +
        ')');
    if (!stdout) {
        throw new Error(`docker run error - ${stderr}`);
    }
    while (await isPortAvailable(port)) {
        await (0, utils_1.promiseTimeout)(50);
    }
    return {
        port,
        dockerId: stdout.trim()
    };
}
const RUNNING_SERVERS = new Map();
function spawnRedisServer(dockerConfig, serverArguments) {
    const runningServer = RUNNING_SERVERS.get(serverArguments);
    if (runningServer) {
        return runningServer;
    }
    const dockerPromise = spawnRedisServerDocker(dockerConfig, serverArguments);
    RUNNING_SERVERS.set(serverArguments, dockerPromise);
    return dockerPromise;
}
exports.spawnRedisServer = spawnRedisServer;
async function dockerRemove(dockerId) {
    const { stderr } = await execAsync(`docker rm -f ${dockerId}`);
    if (stderr) {
        throw new Error(`docker rm error - ${stderr}`);
    }
}
after(() => {
    return Promise.all([...RUNNING_SERVERS.values()].map(async (dockerPromise) => await dockerRemove((await dockerPromise).dockerId)));
});
async function spawnRedisClusterNodeDockers(dockersConfig, serverArguments, fromSlot, toSlot) {
    const range = [];
    for (let i = fromSlot; i < toSlot; i++) {
        range.push(i);
    }
    const master = await spawnRedisClusterNodeDocker(dockersConfig, serverArguments);
    await master.client.clusterAddSlots(range);
    if (!dockersConfig.numberOfReplicas)
        return [master];
    const replicasPromises = [];
    for (let i = 0; i < (dockersConfig.numberOfReplicas ?? 0); i++) {
        replicasPromises.push(spawnRedisClusterNodeDocker(dockersConfig, [
            ...serverArguments,
            '--cluster-enabled',
            'yes',
            '--cluster-node-timeout',
            '5000'
        ]).then(async (replica) => {
            await replica.client.clusterMeet('127.0.0.1', master.docker.port);
            while ((await replica.client.clusterSlots()).length === 0) {
                await (0, utils_1.promiseTimeout)(50);
            }
            await replica.client.clusterReplicate(await master.client.clusterMyId());
            return replica;
        }));
    }
    return [
        master,
        ...await Promise.all(replicasPromises)
    ];
}
async function spawnRedisClusterNodeDocker(dockersConfig, serverArguments) {
    const docker = await spawnRedisServerDocker(dockersConfig, [
        ...serverArguments,
        '--cluster-enabled',
        'yes',
        '--cluster-node-timeout',
        '5000'
    ]), client = client_1.default.create({
        socket: {
            port: docker.port
        }
    });
    await client.connect();
    return {
        docker,
        client
    };
}
const SLOTS = 16384;
async function spawnRedisClusterDockers(dockersConfig, serverArguments) {
    const numberOfMasters = dockersConfig.numberOfMasters ?? 2, slotsPerNode = Math.floor(SLOTS / numberOfMasters), spawnPromises = [];
    for (let i = 0; i < numberOfMasters; i++) {
        const fromSlot = i * slotsPerNode, toSlot = i === numberOfMasters - 1 ? SLOTS : fromSlot + slotsPerNode;
        spawnPromises.push(spawnRedisClusterNodeDockers(dockersConfig, serverArguments, fromSlot, toSlot));
    }
    const nodes = (await Promise.all(spawnPromises)).flat(), meetPromises = [];
    for (let i = 1; i < nodes.length; i++) {
        meetPromises.push(nodes[i].client.clusterMeet('127.0.0.1', nodes[0].docker.port));
    }
    await Promise.all(meetPromises);
    await Promise.all(nodes.map(async ({ client }) => {
        while (totalNodes(await client.clusterSlots()) !== nodes.length) {
            await (0, utils_1.promiseTimeout)(50);
        }
        return client.disconnect();
    }));
    return nodes.map(({ docker }) => docker);
}
function totalNodes(slots) {
    let total = slots.length;
    for (const slot of slots) {
        total += slot.replicas.length;
    }
    return total;
}
const RUNNING_CLUSTERS = new Map();
function spawnRedisCluster(dockersConfig, serverArguments) {
    const runningCluster = RUNNING_CLUSTERS.get(serverArguments);
    if (runningCluster) {
        return runningCluster;
    }
    const dockersPromise = spawnRedisClusterDockers(dockersConfig, serverArguments);
    RUNNING_CLUSTERS.set(serverArguments, dockersPromise);
    return dockersPromise;
}
exports.spawnRedisCluster = spawnRedisCluster;
after(() => {
    return Promise.all([...RUNNING_CLUSTERS.values()].map(async (dockersPromise) => {
        return Promise.all((await dockersPromise).map(({ dockerId }) => dockerRemove(dockerId)));
    }));
});
