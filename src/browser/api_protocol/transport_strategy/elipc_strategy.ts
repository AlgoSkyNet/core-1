/*
Copyright 2017 OpenFin Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
import { AckMessage,  AckFunc, AckPayload } from './ack';
import { ApiTransportBase, MessagePackage } from './api_transport_base';
import { default as RequestHandler } from './base_handler';
import { Endpoint, ActionMap } from '../shapes';
import * as log from '../../log';

declare var require: any;

const coreState = require('../../core_state');
const electronIpc = require('../../transports/electron_ipc');
const system = require('../../api/system').System;
const frameStrategy = coreState.argo.frameStrategy;

// TODO PUT THIS BACK
const bypassLocalFrameConnect = frameStrategy === 'frames';
// const bypassLocalFrameConnect = true;

export class ElipcStrategy extends ApiTransportBase<MessagePackage> {

    constructor(actionMap: ActionMap, requestHandler: RequestHandler<MessagePackage>) {
        super(actionMap, requestHandler);

        this.requestHandler.addHandler((mp: MessagePackage, next: () => void) => {
            const {identity, data, ack, nack, e, strategyName} = mp;

            if (strategyName !== this.constructor.name) {
                next();
            } else {
                const endpoint: Endpoint = this.actionMap[data.action];
                if (endpoint) {
                    // singleFrameOnly check first so to prevent frame superceding when disabled.
                    if (bypassLocalFrameConnect || !data.singleFrameOnly === false || e.sender.isValidWithFrameConnect(e.frameRoutingId)) {
                        Promise.resolve()
                            .then(() => endpoint.apiFunc(identity, data, ack, nack))
                            .then(result => {
                                // older action calls will invoke ack internally, newer ones will return a value
                                if (result !== undefined) {

                                    ack(new AckPayload(result));
                                }
                            }).catch(err => {
                                nack(err);
                            });
                    } else {
                        nack('API access has been superseded by another frame in this window.');
                    }
                }
            }
        });
    }

    public registerMessageHandlers(): void {
        electronIpc.ipc.on(electronIpc.channels.WINDOW_MESSAGE, this.onMessage.bind(this));
    }

    public send(identity: any, payloadObj: any): void {
        system.debugLog(1, `send it to this guy...
            ${JSON.stringify(identity)}
            ${JSON.stringify(payloadObj)}`);

        const { uuid, name } = identity;
        const routingInfo = coreState.getRoutingInfoByUuidFrame(uuid, name);

        if (!routingInfo) { return; } // TODO handle the failed lookup

        const { browserWindow, frameRoutingId } = routingInfo;
        const payload = JSON.stringify(payloadObj);

        // we need to preserve the bulk send (i think...) so if the routing id is 1
        // send to the entire window (potentially all frame ids based on frameConnect)
        const browserWindowLocated = browserWindow;
        const browserWindowExists = !browserWindow.isDestroyed();
        const validRoutingId = typeof frameRoutingId === 'number';
        const canTrySend = browserWindowLocated && browserWindowExists && validRoutingId;

        if (!canTrySend) {
            system.debugLog(1, `uuid:${uuid} name:${name} frameRoutingId:${frameRoutingId} not reachable, payload:${payload}`);
        } else if (frameRoutingId === 1) {
            browserWindow.send(electronIpc.channels.CORE_MESSAGE, payload);
        } else {
            browserWindow.webContents.sendToFrame(frameRoutingId, electronIpc.channels.CORE_MESSAGE, payload);
        }
    }

    //TODO: this needs to be refactor at some point.
    public onClientAuthenticated(cb: Function): void {
        throw new Error('Not implemented');
    }

    //TODO: this needs to be refactor at some point.
    public onClientDisconnect(cb: Function): void {
        throw new Error('Not implemented');
    }

    protected onMessage(e: any, rawData: any): void {

        try {
            const data = JSON.parse(JSON.stringify(rawData));
            const ack = !data.isSync ? this.ackDecorator(e, data.messageId) : this.ackDecoratorSync(e, data.messageId);
            const nack = this.nackDecorator(ack);
            const browserWindow = e.sender.getOwnerBrowserWindow();
            const currWindow = browserWindow ? coreState.getWinById(browserWindow.id) : null;
            const openfinWindow = currWindow.openfinWindow;
            const opts = openfinWindow && openfinWindow._options || {};
            const subFrameName = bypassLocalFrameConnect ? e.sender.getFrameName(e.frameRoutingId) : null;
            const identity = {
                name: subFrameName || opts.name,
                uuid: opts.uuid,
                parentFrame: opts.name, //rename to 'parent'?
                entityType: e.sender.getEntityType(e.frameRoutingId)
            };

            system.debugLog(1, `this is my frame name ${e.sender.getFrameName(e.frameRoutingId)}`);

            /* tslint:disable: max-line-length */
            //message payload might contain sensitive data, mask it.
            const disableIabSecureLogging = coreState.getAppObjByUuid(opts.uuid)._options.disableIabSecureLogging;
            const replacer = (!disableIabSecureLogging && (data.action === 'publish-message' || data.action === 'send-message')) ? this.payloadReplacer : null;
            system.debugLog(1, `received in-runtime${data.isSync ? '-sync ' : ''}: ${e.frameRoutingId} [${identity.uuid}]-[${identity.name}] ${JSON.stringify(data, replacer)}`);
            /* tslint:enable: max-line-length */


            this.requestHandler.handle({
                identity, data, ack, nack, e,
                strategyName: this.constructor.name
            });

        } catch (err) {
            system.debugLog(1, err);
        }
    }

    protected ackDecoratorSync(e: any, messageId: number): AckFunc {
        const ackObj = new AckMessage();
        ackObj.correlationId = messageId;

        return (payload: any): void => {
            ackObj.payload = payload;

            try {
                // Log all messages when -v=1
                system.debugLog(1, `sent sync in-runtime <= ${JSON.stringify(ackObj)}`);
            } catch (err) {
                /* tslint:disable: no-empty */
            }

            if (!e.sender.isDestroyed()) {
                e.returnValue = JSON.stringify(ackObj);
            }
        };
    }

    protected ackDecorator(e: any, messageId: number): AckFunc {
        const ackObj = new AckMessage();
        ackObj.correlationId = messageId;

        return (payload: any): void => {
            ackObj.payload = payload;

            try {
                // Log all messages when -v=1
                /* tslint:disable: max-line-length */
                system.debugLog(1, `sent in-runtime <= ${e.frameRoutingId} ${JSON.stringify(ackObj)}`);
            } catch (err) {
                /* tslint:disable: no-empty */
            }

            if (!e.sender.isDestroyed()) {
                e.sender.sendToFrame(e.frameRoutingId, electronIpc.channels.CORE_MESSAGE, JSON.stringify(ackObj));
            }
        };

    }
}
