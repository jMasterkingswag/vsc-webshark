/* --------------------
 * Copyright(C) Matthias Behr, 2020.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as tshark from './tshark';
import { QuickInputHelper, PickItem } from './quickPick';

const platformWin32: boolean = process.platform === "win32";
const separator = platformWin32 ? '"' : "'"; // win cmd uses ", unix sh uses '

export async function filterPcap(uri: vscode.Uri) {

    const confTshark = vscode.workspace.getConfiguration().get<string>('vsc-webshark.tsharkFullPath');
    const tsharkFullPath: string = confTshark ? confTshark : 'tshark';

    const confSteps = vscode.workspace.getConfiguration().get<Array<any>>('vsc-webshark.filterSteps');

    console.log(`filterPcap(${uri.toString()}) with tsharkFullPath='${tsharkFullPath}' and ${confSteps?.length} steps...`);

    if (confSteps === undefined || confSteps.length === 0) {
        vscode.window.showErrorMessage('please check your vsc-webshark.filterSteps configuration! None defined.', { modal: true });
        return;
    }

    const steps: object[] = [...confSteps];

    // clear any prev. results:
    for (let s = 0; s < steps.length; ++s) {
        const step: any = steps[s];
        step.listProviderFinished = undefined;
        step.listProviderData = undefined;
        step.results = undefined;
    }

    const updatePickItem = function (item: PickItem, data: any, key: string, listDescription: string[] | undefined): void {
        item.name = key;
        if (data.icon) {
            item.icon = data.icon;
        }
        item.data = { key: key, data: data };
        let descString: string = '';
        if (listDescription) {
            for (let i = 0; i < listDescription.length; ++i) {
                descString += data[listDescription[i]];
            }
        }
        item.description = descString;
    };

    const updateQuickPick = function (stepData: any, data: tshark.ListData, items: PickItem[], quickPick: vscode.QuickPick<PickItem>, selectedItems: PickItem[] | undefined = undefined): void {
        stepData.listProviderData = data; // store in case we'd like to go back
        //console.log(`got ListData map.size=${data.map.size}`);
        data.map.forEach((value, key) => {
            const oldItemIdx = items.findIndex((value) => {
                if (value?.data?.key === key) { return true; }
                return false;
            });
            if (oldItemIdx !== -1) {
                updatePickItem(items[oldItemIdx], value, key, stepData.listDescription);
            } else {
                console.log(`got new ListData: key='${key}', data='${JSON.stringify(value)}'`);
                const newItem = new PickItem();
                if (stepData.listIcon) { value.icon = stepData.listIcon; }
                updatePickItem(newItem, value, key, stepData.listDescription);
                items.push(newItem);
            }
        });
        // as we can only overwrite the full set we need to mark the selected ones:
        const newSelItems: PickItem[] = [];
        const selectedItemsToUse = selectedItems ? selectedItems : quickPick.selectedItems;
        selectedItemsToUse.forEach((selItem) => {
            const itemIdx = items.findIndex((newVal) => {
                if (newVal?.data?.key === selItem?.data?.key) { return true; }
                return false;
            });
            if (itemIdx !== -1) {
                newSelItems.push(items[itemIdx]);
            }
        });
        quickPick.items = items;
        quickPick.selectedItems = newSelItems;
    };

    const getFilterExpr = function (stepData: any, items: readonly PickItem[] | string): string {
        // return a tshark filter expression to be used with -Y ...
        let filter: string = '';

        if (Array.isArray(items)) {
            for (let i = 0; i < items.length; ++i) {
                const item = items[i];
                console.log(` getFilterExpr item=${JSON.stringify(item)}`);
                if (item.data.key.length === 0) { continue; }// skip
                if (filter.length > 0) {
                    filter += ' or ';
                }
                if (item.data.data?.filterField !== undefined) {
                    filter += item.data.data.filterField;
                } else {
                    filter += stepData.filterField;
                }
                filter += `==${item.data.key}`;
            }

            if (stepData.filterNegate !== undefined && stepData.filterNegate && filter.length > 0) {
                filter = `!(${filter})`;
            }
        } else {
            filter = <string>items;
        }

        return filter;
    };

    const getTSharkArgs = function (steps: any[]): string[][] {
        let tsharkArgs: string[][] = [];
        for (let s = 0; s < steps.length; ++s) {
            const stepData: any = steps[s];
            const filterExpr = getFilterExpr(stepData, stepData.results);
            let stepArgs: string[] = stepData.filterArgs ? [...stepData.filterArgs] : [];
            if (filterExpr.length) {
                stepArgs.push(`-Y ${separator}${filterExpr}${separator}`);
            }
            console.log(`got filter from step ${s}: '${filterExpr}'`);
            console.log(`got tsharkArgs from step ${s}: '${stepArgs.join(' ')}'`);
            if (stepArgs.length) { tsharkArgs.push(stepArgs); }
        }
        return tsharkArgs;
    };

    for (let s = 0; s < steps.length; ++s) {
        const stepData: any = steps[s];
        const items: PickItem[] = [];

        if (stepData.staticItems) {
            for (let i = 0; i < stepData.staticItems.length; ++i) {
                const staticData = stepData.staticItems[i];
                const staticItem = new PickItem();
                updatePickItem(staticItem, staticData, staticData.key, stepData.listDescription);
                items.push(staticItem);
            }
        }

        // create quickpick but don't show yet:
        const quickPick = QuickInputHelper.createQuickPick<PickItem>('filter pcap...', s + 1, steps.length + 1); // last step is save...
        quickPick.placeholder = stepData.title;
        quickPick.items = items;
        quickPick.selectedItems = items; // the static items are pre-selected

        if (stepData.listProviderData !== undefined) {
            // we got some data already:
            updateQuickPick(stepData, stepData.listProviderData, items, quickPick, stepData.results);
        }

        // do a search in the background?
        let tsharkLP: tshark.TSharkListProvider | undefined = undefined;
        if (stepData["listProvider"] && !stepData.listProviderFinished) {
            // add the tsharkArgs from previous steps:
            let tsharkArgs = getTSharkArgs(steps.slice(0, s));
            tsharkArgs = tsharkArgs.concat(stepData.listProvider);
            tsharkLP = new tshark.TSharkListProvider(tsharkFullPath, tsharkArgs, null, uri.fsPath); // todo mapper
            quickPick.busy = true;

            tsharkLP.onDidChangeData((data: tshark.ListData) => {
                updateQuickPick(stepData, data, items, quickPick);
            });
            tsharkLP.done().then(value => {
                console.log(`tsharkLP.done(value=${value})`);
                quickPick.busy = false;
                if (value === 0) {
                    stepData.listProviderFinished = true;
                }
            });
        }

        let doCancel = false;
        let doBack = false;
        await QuickInputHelper.show(quickPick).then((selectedItems) => {
            console.log(`got selectedItems.length=${selectedItems?.length}`);
            // if the results lead to a changed filterExpr we have to invalidate the listProvider for next steps (if any):
            if (stepData.results !== undefined) {
                // do we have another step with listProviderFinished?
                if (s + 1 < steps.length) {
                    const nextStepData: any = steps[s + 1];
                    if (nextStepData.listProviderFinished !== undefined && nextStepData.listProviderFinished) {
                        // are the filterExpr different?
                        const oldFilterExpr = getFilterExpr(stepData, stepData.results);
                        const newFilterExpr = getFilterExpr(stepData, selectedItems);
                        if (oldFilterExpr !== newFilterExpr) {
                            console.log(`invalidated next steps listProvider`);
                            nextStepData.listProviderFinished = undefined;
                        }
                    }
                }
            }
            stepData.results = selectedItems;
        }).catch(err => {
            if (err === vscode.QuickInputButtons.Back) {
                doBack = true;
            } else {
                console.log(`step loop got err:${err}`);
                doCancel = true;
            }
        });
        console.log(`step ${s} done. `);

        if (tsharkLP !== undefined) {
            tsharkLP.dispose();
        }
        quickPick.dispose();

        if (doCancel) { break; }
        if (doBack) {
            s -= 2;
        }
    }

    // steps done. now save (if last step has results)
    if (steps.length > 0) {
        const lastStep: any = steps[steps.length - 1];
        if (lastStep.results !== undefined) {
            let doRetry;
            do {
                doRetry = false;
                await vscode.window.showSaveDialog({ defaultUri: uri.with({ path: uri.path + '_filtered.pcap' }), saveLabel: 'save filtered pcap as ...' }).then(async saveUri => {
                    if (saveUri) {
                        console.log(`save as uri=${saveUri?.toString()}`);
                        if (saveUri.toString() === uri.toString()) {
                            vscode.window.showErrorMessage('Filtering into same file not possible. Please choose a different one.', { modal: true });
                            doRetry = true;
                        } else {
                            let tsharkArgs: string[][] = getTSharkArgs(steps);
                            if (tsharkArgs.length) {
                                vscode.window.withProgress(
                                    { cancellable: true, location: vscode.ProgressLocation.Notification, title: `filtering file to ${saveUri.toString()}` },
                                    async (progress, cancelToken) => {
                                        // run tshark:
                                        let receivedData: Buffer[] = [];
                                        const tp = new tshark.TSharkProcess(tsharkFullPath,
                                            tsharkArgs,
                                            (data: Buffer) => {
                                                receivedData.push(data);
                                            }, uri.fsPath, saveUri.fsPath);
                                        let wasCancelled = false;
                                        cancelToken.onCancellationRequested(() => {
                                            console.log(`filtering cancelled.`);
                                            wasCancelled = true;
                                            tp.dispose();
                                        });
                                        progress.report({ message: `Applying ${tsharkArgs.length} filter...` });
                                        let interval = setInterval(() => {
                                            var stats = fs.statSync(saveUri.fsPath);
                                            const fileSize = stats["size"] / (1000 * 1000);
                                            progress.report({ message: `Applying ${tsharkArgs.length} filter... generated ${Math.round(fileSize)}MB` });
                                        }, 1000); // todo could add number of seconds running as well
                                        await tp.done().then((res: number) => {
                                            if (res === 0) {
                                                vscode.window.showInformationMessage(`successfully filtered file '${saveUri.toString()}'`);
                                                const receivedStrs = receivedData.join('').split('\n');
                                                console.log(`done receivedStrs=${receivedStrs.length}`);
                                                for (let i = 0; i < receivedStrs.length; ++i) {
                                                    const line = receivedStrs[i];
                                                    console.log(line);
                                                }
                                            } else {
                                                if (!wasCancelled) {
                                                    vscode.window.showErrorMessage(`filtering file failed with res=${res}`, { modal: true });
                                                }
                                            }
                                        }).catch((err) => {
                                            console.log(`got err:${err}`);
                                            vscode.window.showErrorMessage(`filtering file failed with err=${err}`, { modal: true });
                                        });
                                        clearInterval(interval);
                                    }
                                );
                            }
                        }
                    }
                });
            } while (doRetry);
        }
    }
    console.log(`filterPcap(uri=${uri.toString()}) done`);
}
