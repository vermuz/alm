/**
 * We should have all the CM docs cached for consistent history and stuff
 */
import {TypedEvent} from "../../../common/events";
import * as codemirror from "codemirror";
import {cast, server} from "../../../socket/socketClient";
import * as utils from "../../../common/utils";
import * as classifierCache from "./classifierCache";
import {RefactoringsByFilePath,Refactoring} from "../../../common/types";

let docByFilePath: { [filePath: string]: codemirror.Doc } = {};
let localSourceIdByFilePath : { [filePath: string]: string } = {};
export function getLinkedDoc(filePath: string): Promise<codemirror.Doc> {
    return getOrCreateDoc(filePath)
        .then(doc=> {

            // some housekeeping, clear previous links that no longer seem active
            let markForRemove: codemirror.Doc[] = [];
            doc.iterLinkedDocs((linked)=>{
                if (!linked.getEditor()){
                    markForRemove.push(linked)
                }
            });
            markForRemove.forEach(linked=>{doc.unlinkDoc(linked);});

            return doc.linkedDoc({ sharedHist: true })
        });
}

function getOrCreateDoc(filePath: string) {
    if (docByFilePath[filePath]) {
        return Promise.resolve(docByFilePath[filePath]);
    }
    else {
        return server.openFile({ filePath: filePath }).then((res) => {
            let mode = 'typescript'; // text/html

            // we need this by file path because linked docs get their own id for some reason
            localSourceIdByFilePath[filePath] = utils.createId();

            // Add to classifier cache
            classifierCache.addFile(filePath, res.contents);

            // create the doc
            let doc = docByFilePath[filePath] = new codemirror.Doc(res.contents, mode);
            doc.filePath = filePath;

            // setup to push doc changes to server
            (doc as any).on('change', (doc: codemirror.Doc, change: CodeMirror.EditorChange) => {
                if (change.origin == localSourceIdByFilePath[filePath]) {
                    return;
                }

                let codeEdit: CodeEdit = {
                    from: { line: change.from.line, ch: change.from.ch },
                    to: { line: change.to.line, ch: change.to.ch },
                    newText: change.text.join('\n'),
                    sourceId: localSourceIdByFilePath[filePath]
                };

                // Keep the classifier in sync
                classifierCache.editFile(filePath, codeEdit);

                // Send the edit
                server.editFile({ filePath: filePath, edit: codeEdit });
            });

            // setup to get doc changes from server
            cast.didEdit.on(res=> {
                let codeEdit = res.edit;
                if (res.filePath == filePath && codeEdit.sourceId !== localSourceIdByFilePath[filePath]) {
                    // Keep the classifier in sync
                    classifierCache.editFile(filePath, codeEdit);

                    // Note that we use *our source id* as this is now a change *we are making to code mirror* :)
                    doc.replaceRange(codeEdit.newText, codeEdit.from, codeEdit.to, localSourceIdByFilePath[filePath]);
                }
            });

            // setup loading saved files changing on disk
            cast.savedFileChangedOnDisk.on((res) => {
                if (res.filePath == filePath
                    && doc.getValue() !== res.contents) {

                    // Keep the classifier in sync
                    classifierCache.setContents(filePath, res.contents);

                    // preserve cursor
                    let cursor = doc.getCursor();

                    // Note that we use *our source id* as this is now a change *we are making to code mirror* :)
                    // Not using setValue as it doesn't take sourceId
                    let lastLine = doc.lastLine();
                    let lastCh = doc.getLine(lastLine).length;
                    doc.replaceRange(res.contents, { line: 0, ch: 0 }, { line: lastLine, ch: lastCh }, localSourceIdByFilePath[filePath]);

                    // restore cursor
                    doc.setCursor(cursor);
                }
            })

            // Finally return the doc
            return doc;
        });
    }
}

/**
 * Don't plan to export as giving others our true docs can have horrible consequences if they mess them up
 */
function getOrCreateDocs(filePaths: string[]): Promise<{ [filePath: string]: codemirror.Doc }> {
    let promises = filePaths.map(fp => getOrCreateDoc(fp));
    return Promise.all(promises).then(docs => {
        let res: { [filePath: string]: codemirror.Doc } = {};
        docs.forEach(doc => res[doc.filePath] = doc);
        return res;
    });
}

export function applyRefactoringsToDocs(refactorings: RefactoringsByFilePath) {
    let filePaths = Object.keys(refactorings);
    getOrCreateDocs(filePaths).then(docsByFilePath => {
        filePaths.forEach(fp=>{
            let doc = docsByFilePath[fp];
            let changes = refactorings[fp];
            for (let change of changes) {
                let from = classifierCache.getLineAndCharacterOfPosition(fp,change.span.start);
                let to = classifierCache.getLineAndCharacterOfPosition(fp,change.span.start + change.span.length);
                doc.replaceRange(change.newText, from, to, 'refactor');
            }
        });
    });
}
