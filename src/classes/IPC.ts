/* eslint @typescript-eslint/no-unsafe-call: 1 */
/* eslint @typescript-eslint/no-unsafe-member-access: 1 */
import { IPC } from 'node-ipc';
import log from '../lib/logger';
import Bot from './Bot';
import fs, { promises as fsp } from 'fs';
import path from 'path';
import Options, { getOptionsPath, JsonOptions, removeCliOptions } from './Options';
import generateCert from '../lib/tools/generateCert';
import { EntryData } from './Pricelist';
import { deepMerge } from '../lib/tools/deep-merge';
import validator from '../lib/validator';

export default class ipcHandler extends IPC {
    ourServer: any;

    bot: Bot;

    options: Options;

    privateKey?: string;

    publicKey?: string;

    serverCert?: string;

    caCert?: string;

    constructor(bot: Bot) {
        super();
        this.server = null;
        this.bot = bot;
        this.options = bot.options;
        if (this.options.tls) {
            this.publicKey = path.join(__dirname, `../../files/${this.bot.options.steamAccountName}/client.pub`);
            this.privateKey = path.join(__dirname, `../../files/${this.bot.options.steamAccountName}/client.key`);
            this.serverCert = path.join(__dirname, `../../files/${this.bot.options.steamAccountName}/server.pem`);
            this.caCert = path.join(__dirname, `../../files/${this.bot.options.steamAccountName}/ca.pem`);
        }
    }

    init(): void {
        this.config.id = this.bot.client.steamID.getSteamID64();
        this.config.retry = 15000;
        //this.config.silent = true;

        if (this.options.tls) {
            this.config.networkHost = this.options.tlsHost;
            this.config.networkPort = this.options.tlsPort;
            if (!fs.existsSync(this.publicKey) || !fs.existsSync(this.privateKey)) {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                const { certificate, privateKey } = generateCert();
                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                fs.writeFileSync(this.publicKey, certificate);
                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                fs.writeFileSync(this.privateKey, privateKey);
            }

            if (!fs.existsSync(this.serverCert) || !fs.existsSync(this.caCert)) {
                log.error('Servers public key not found');
                throw new Error('Servers public key not found');
            }
            this.config.tls = {
                private: this.privateKey,
                public: this.publicKey,
                trustedConnections: this.serverCert,
                ca: fs.readFileSync(this.caCert)
            } as Record<string, unknown>; //Ignore TS once again
        }

        // eslint-disable-next-line
        const onConnected = () => {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-assignment
            this.ourServer = this.of.autobot_gui_dev;
            log.debug('connected IPC');

            //bind handlers
            this.ourServer.on('connect', this.connected.bind(this));
            this.ourServer.on('getInfo', this.sendInfo.bind(this));
            this.ourServer.on('getPricelist', this.sendPricelist.bind(this));
            this.ourServer.on('disconnected', this.disconnected.bind(this));
            this.ourServer.on('addItem', this.addItem.bind(this));
            this.ourServer.on('updateItem', this.updateItem.bind(this));
            this.ourServer.on('removeItem', this.removeItem.bind(this));
            this.ourServer.on('getTrades', this.sendTrades.bind(this));
            this.ourServer.on('getInventory', this.sendInventory.bind(this));
            this.ourServer.on('sendChat', this.sendChat.bind(this));
            this.ourServer.on('getOptions', this.sendOptions.bind(this));
            this.ourServer.on('updateOptions', this.updateOptions.bind(this));
        };
        if (this.options.tls) this.connectToNet('autobot_gui_dev', onConnected);
        else this.connectTo('autobot_gui_dev', onConnected);
    }

    private static cleanItem(item): void {
        if (item?.name) delete item.name;
        if (item?.time) delete item.time;
        if (item?.statslink) delete item.statslink;
        if (item?.style) delete item.style;
    }

    /* HANDLERS */
    private addItem(item: any): void {
        ipcHandler.cleanItem(item);

        let priceKey: string = undefined;
        if (item.id) {
            priceKey = item.id as string;
        }
        priceKey = priceKey ? priceKey : (item.sku as string);
        this.bot.pricelist
            .addPrice({ entryData: item as EntryData, emitChange: true })
            .then(item => {
                this.ourServer.emit('itemAdded', Object.assign(item, priceKey === item.sku ? {} : { id: priceKey }));
            })
            .catch((e: string) => {
                this.ourServer.emit('itemAdded', e);
            });
    }

    private updateItem(item): void {
        ipcHandler.cleanItem(item);

        let priceKey: string = undefined;
        if (item.id) {
            priceKey = item.id as string;
        }
        priceKey = priceKey ? priceKey : (item.sku as string);
        this.bot.pricelist
            .updatePrice({ priceKey, entryData: item as EntryData, emitChange: true })
            .then(item => {
                this.ourServer.emit('itemUpdated', Object.assign(item, priceKey === item.sku ? {} : { id: priceKey }));
            })
            .catch((e: string) => {
                this.ourServer.emit('itemUpdated', e);
            });
    }

    private removeItem(priceKey: string): void {
        this.bot.pricelist
            .removePrice(priceKey, true)
            .then(item => {
                this.ourServer.emit('itemRemoved', Object.assign(item, priceKey === item.sku ? {} : { id: priceKey }));
            })
            .catch((e: string) => {
                this.ourServer.emit('itemRemoved', e);
            });
    }

    private connected(): void {
        log.info('IPC connected');
    }

    private disconnected(): void {
        log.warn('IPC disconnect');
    }

    private sendInfo(): void {
        this.ourServer.emit('info', {
            id: this.bot.client.steamID.getSteamID64(),
            admins: this.bot.getAdmins.map(id => id.getSteamID64()),
            name: this.bot.options.steamAccountName
        });
    }

    sendPricelist(): void {
        const pricelist = this.bot.pricelist.getPrices;
        if (pricelist) {
            const pricelistMapped = Object.keys(pricelist).map(key => {
                const item = pricelist[key];
                if (item.sku !== key) {
                    return Object.assign(item, { id: key });
                } else {
                    return item;
                }
            });
            this.ourServer.emit('pricelist', pricelistMapped);
        } else {
            this.ourServer.emit('pricelist', false);
        }
    }

    sendTrades(): void {
        this.ourServer.emit('polldata', this.bot.manager.pollData);
    }

    private sendChat(message: string): void {
        this.bot.handler
            .onMessage(this.bot.getAdmins[0], message, false)
            .then(msg => {
                this.ourServer.emit('chatResp', msg);
            })
            .catch((e: string) => {
                this.ourServer.emit('chatResp', e);
            });
    }

    sendInventory(): void {
        this.ourServer.emit('inventory', this.bot.inventoryManager.getInventory.getItems);
    }

    sendOptions(): void {
        const saveOptions = deepMerge({}, this.bot.options) as JsonOptions;
        removeCliOptions(saveOptions);

        this.ourServer.emit('options', saveOptions);
    }

    updateOptions(newOptions): void {
        const opt = this.bot.options;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        const errors = validator(newOptions, 'options');
        if (errors !== null) {
            const msg = '❌ Error updating options: ' + errors.join(', ');
            this.ourServer.emit('optionsUpdated', msg);
            return;
        }
        const optionsPath = getOptionsPath(opt.steamAccountName);
        fsp.writeFile(optionsPath, JSON.stringify(newOptions, null, 4), { encoding: 'utf8' })
            .then(() => {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                deepMerge(opt, newOptions);
                const msg = '✅ Updated options!';

                this.ourServer.emit('optionsUpdated', msg);
            })
            .catch(err => {
                const errStringify = JSON.stringify(err);
                const errMessage = errStringify === '' ? (err as Error)?.message : errStringify;
                const msg = `❌ Error saving options file to disk: ${errMessage}`;
                this.ourServer.emit('optionsUpdated', msg);
                return;
            });
    }
}