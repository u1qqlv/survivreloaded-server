import crypto from "crypto";
import {
    type Emote,
    type Explosion,
    GameOptions,
    randomVec,
    removeFrom,
    SurvivBitStream as BitStream,
    unitVecToRadians,
    Weapons
} from "../utils";
import { Bodies, type Body, Collision, Composite, Engine, Vector } from "matter-js";
import { Map } from "./map";
import { Player } from "./objects/player";
import { Obstacle } from "./objects/obstacle";
import { AliveCountsPacket } from "../packets/sending/aliveCountsPacket";
import { UpdatePacket } from "../packets/sending/updatePacket";
import { JoinedPacket } from "../packets/sending/joinedPacket";
import { MapPacket } from "../packets/sending/mapPacket";
import { type KillPacket } from "../packets/sending/killPacket";

export class Game {

    /***
     * The game ID. 16 hex characters, same as MD5
     */
    id: string;

    map: Map;

    /***
     * All players, including dead and disconnected players.
     */
    players: Player[] = [];

    /***
     * All connected players. May be dead.
     */
    connectedPlayers: Player[] = [];

    /***
     * All connected and living players.
     */
    activePlayers: Player[] = [];

    dirtyPlayers: Player[] = [];
    aliveCount = 0;
    aliveCountDirty = false;
    playerInfosDirty = false;
    deletedPlayerIds: number[] = [];
    emotes: Emote[] = [];
    explosions: Explosion[] = [];
    kills: KillPacket[] = [];
    fullDirtyObjects: number[] = [];
    partialDirtyObjects: number[] = [];

    timer: NodeJS.Timer;

    engine: Engine;
    gasMode: number;
    initialGasDuration: number;
    oldGasPosition: Vector;
    newGasPosition: Vector;
    oldGasRadius: number;
    newGasRadius: number;

    constructor() {
        this.id = crypto.createHash("md5").update(crypto.randomBytes(512)).digest("hex");

        this.gasMode = 0;
        this.initialGasDuration = 0;
        this.oldGasPosition = Vector.create(360, 360);
        this.newGasPosition = Vector.create(360, 360);
        this.oldGasRadius = 2048;
        this.newGasRadius = 2048;

        this.engine = Engine.create();
        this.engine.gravity.scale = 0; // Disable gravity

        this.map = new Map(this, "main");

        this.timer = setInterval(() => {

            // Update physics engine
            Engine.update(this.engine, GameOptions.tickDelta);

            // First loop: Calculate movement & animations.
            for(const p of this.activePlayers) {

                // TODO: Only check objects when player moves 1 unit. No reason to check every 0.2 units.

                // Movement
                p.moving = true;
                const s = GameOptions.movementSpeed; const ds = GameOptions.diagonalSpeed;
                if(p.movingUp && p.movingLeft) p.setVelocity(-ds, ds);
                else if(p.movingUp && p.movingRight) p.setVelocity(ds, ds);
                else if(p.movingDown && p.movingLeft) p.setVelocity(-ds, -ds);
                else if(p.movingDown && p.movingRight) p.setVelocity(ds, -ds);
                else if(p.movingUp) p.setVelocity(0, s);
                else if(p.movingDown) p.setVelocity(0, -s);
                else if(p.movingLeft) p.setVelocity(-s, 0);
                else if(p.movingRight) p.setVelocity(s, 0);
                else {
                    p.setVelocity(0, 0);
                    if(p.moving) p.setVelocity(0, 0);
                    p.moving = false;
                }

                // p.updateVisibleObjects();

                if(p.shootStart) {
                    p.shootStart = false;
                    if(Date.now() - p.meleeCooldown >= 250) {
                        p.meleeCooldown = Date.now();

                        // Start punching animation
                        if(!p.animActive) {
                            p.animActive = true;
                            p.animType = 1;
                            p.animTime = 0;
                        }

                        // If the player is punching anything, damage the closest object
                        let maxDepth = -1; let closestObject: (Player | Obstacle | null) = null;
                        const weapon = Weapons[p.loadout.meleeType];
                            const angle = unitVecToRadians(p.direction);
                            const offset = Vector.add(weapon.attack.offset, Vector.mult(Vector.create(1, 0), p.scale - 1));
                            const position = Vector.add(p.position, Vector.rotate(offset, angle));
                        const body: Body = Bodies.circle(position.x, position.y, 0.9);
                        for(const object of this.map.objects) { // TODO This is very inefficient. Only check visible objects
                            if(!object.body || object.dead || object.id === p.id) continue;
                            if(((object instanceof Obstacle && object.destructible) || object instanceof Player)) {
                                // @ts-expect-error The 3rd argument for Collision.collides is optional
                                const collision = Collision.collides(body, object.body);
                                if(collision && collision.depth > maxDepth) {
                                    maxDepth = collision.depth;
                                    closestObject = object;
                                }
                            }
                        }
                        if(closestObject!) {
                            closestObject.damage(24, p);
                            if(closestObject instanceof Obstacle && closestObject.isDoor) closestObject.interact(p);
                        }

                        /* This code is more efficient, but doesn't work:
                        for(const id of p.visibleObjects) {
                            const object = this.map.objects[id];
                            if(!object.body || object.dead || object.id == p.id) continue;
                            if(((object instanceof Obstacle && object.destructible) || object instanceof Player)) {
                                const collision: Collision = Collision.collides(body, object.body);
                                if(collision && collision.depth > maxDepth) {
                                    maxDepth = collision.depth;
                                    closestObject = object;
                                }
                            }
                        }
                        */
                    }
                }

                if(p.animActive) {
                    this.fullDirtyObjects.push(p.id);
                    p.fullObjects.push(p.id);
                    p.animTime++;
                    p.animSeq = 1;
                    if(p.animTime > 8) {
                        p.animActive = false;
                        p.animType = p.animSeq = p.animTime = 0;
                    }
                } else {
                    this.partialDirtyObjects.push(p.id);
                    p.partialObjects.push(p.id); // TODO Check for movement first
                }
            }

            // Second loop: calculate visible objects & send packets
            for(const p of this.connectedPlayers) {
                p.skipObjectCalculations = !this.fullDirtyObjects.length && !this.partialDirtyObjects.length && !p.moving;

                if(this.emotes.length > 0) {
                    p.emotesDirty = true;
                    p.emotes = this.emotes;
                }

                if(this.explosions.length > 0) {
                    p.explosionsDirty = true;
                    p.explosions = this.explosions;
                }

                if(this.fullDirtyObjects.length > 0) {
                    for(const id of this.fullDirtyObjects) {
                        if(p.visibleObjects.includes(id)) p.fullObjects.push(id);
                    }
                }

                if(this.partialDirtyObjects.length > 0) {
                    for(const id of this.partialDirtyObjects) {
                        if(p.visibleObjects.includes(id)) p.partialObjects.push(id);
                    }
                }

                p.sendPacket(new UpdatePacket(p));
                if(this.aliveCountDirty) p.sendPacket(new AliveCountsPacket(p));
                if(this.kills.length) {
                    for(const kill of this.kills) p.sendPacket(kill);
                }
            }

            // Reset everything
            this.emotes = [];
            this.explosions = [];
            this.kills = [];
            this.fullDirtyObjects = [];
            this.partialDirtyObjects = [];
            this.dirtyPlayers = [];
            this.deletedPlayerIds = [];
            this.aliveCountDirty = false;
        }, GameOptions.tickDelta);
    }

    addPlayer(socket, username, loadout): Player {
        let spawnPosition;
        if(GameOptions.debugMode) spawnPosition = Vector.create(450, 150);
        else spawnPosition = randomVec(75, this.map.width - 75, 75, this.map.height - 75);

        const p = new Player(this.map.objects.length, spawnPosition, socket, this, username, loadout);
        this.map.objects.push(p);
        this.players.push(p);
        this.connectedPlayers.push(p);
        this.activePlayers.push(p);
        this.dirtyPlayers.push(p);
        this.fullDirtyObjects.push(p.id);
        this.aliveCount++;
        this.aliveCountDirty = true;
        this.playerInfosDirty = true;

        p.sendPacket(new JoinedPacket(p));
        const stream = BitStream.alloc(32768);
        new MapPacket(p).writeData(stream);
        p.fullObjects.push(p.id);
        new UpdatePacket(p).writeData(stream);
        new AliveCountsPacket(p).writeData(stream);
        p.sendData(stream);

        return p;
    }

    removePlayer(p): void {
        p.direction = Vector.create(1, 0);
        p.quit = true;
        this.deletedPlayerIds.push(p.id);
        this.partialDirtyObjects.push(p.id);
        removeFrom(this.activePlayers, p);
        removeFrom(this.connectedPlayers, p);
        if(!p.dead) {
            this.aliveCount--;
            this.aliveCountDirty = true;
        }
    }

    addBody(body): void {
        Composite.add(this.engine.world, body);
    }

    removeBody(body): void {
        Composite.remove(this.engine.world, body);
    }

    end(): void {
        for(const p of this.players) p.socket.close();
        clearInterval(this.timer);
    }

}
