/** Copyright 2014-2019 Stewart Allen -- All Rights Reserved */

"use strict";

let gs_kiri_sla = exports;

(function() {

    if (!self.kiri) self.kiri = { };
    if (!self.kiri.driver) self.kiri.driver = { };
    if (self.kiri.driver.SLA) return;

    let KIRI = self.kiri,
        BASE = self.base,
        DBUG = BASE.debug,
        UTIL = BASE.util,
        CONF = BASE.config,
        POLY = BASE.polygons,
        SLA = KIRI.driver.SLA = {
            slice,
            printSetup,
            printExport,
            printDownload,
            printRender
        },
        SLICER = KIRI.slicer,
        newPoint = BASE.newPoint;

    /**
     * DRIVER SLICE CONTRACT - runs in worker
     *
     * @param {Object} settings
     * @param {Widget} Widget
     * @param {Function} onupdate (called with % complete and optional message)
     * @param {Function} ondone (called when complete with an array of Slice objects)
     */
    function slice(settings, widget, onupdate, ondone) {
        let process = settings.process,
            device = settings.device;

        // calculate % complete and call onupdate()
        function doupdate(slices, index, from, to, msg) {
            onupdate(0.5 + (from + ((index / slices.length) * (to - from))) * 0.5, msg);
        }

        // for each slice, performe a function and call doupdate()
        function forSlices(slices, from, to, fn, msg) {
            slices.forEach(function(slice) {
                fn(slice);
                doupdate(slices, slice.index, from, to, msg)
            });
        }

        SLICER.sliceWidget(widget, {
            height: process.slaSlice || 0.05
        }, function(slices) {
            widget.slices = slices;
            // reset for solids and support projections
            slices.forEach(function(slice) {
                slice.invalidateFill();
                slice.invalidateSolids();
                slice.invalidateSupports();
                slice.isSolidFill = false;
            });
            forSlices(slices, 0.0, 0.2, (slice) => {
                slice.doShells(1, 0);
                // slice.tops.forEach(top => { top.solids = [] });
            }, "slice");
            forSlices(slices, 0.2, 0.4, (slice) => {
                slice.doDiff(0.00001, 0.005);
            }, "delta");
            forSlices(slices, 0.4, 0.5, (slice) => {
                slice.projectFlats(process.slaSolids || 5);
                slice.projectBridges(process.slaSolids || 5);
            }, "project");
            forSlices(slices, 0.5, 0.6, (slice) => {
                slice.doSolidsFill(undefined, undefined, 0.00001);
            }, "solid");
            ondone();
        }, function(update) {
            return onupdate(0.0 + update * 0.5);
        });
    };

    /**
     * DRIVER PRINT CONTRACT - runs in worker
     * @param {Object} print state object
     * @param {Function} update incremental callback
     */
    function printSetup(print, update) {
        let widgets = print.widgets,
            settings = print.settings,
            device = settings.device,
            process = settings.process,
            output = print.images = [],
            layermax = 0,
            width = 2560,
            height = 1440,
            width2 = width/2,
            height2 = height/2;

        widgets.forEach(widget => {
            layermax = Math.max(widget.slices.length);
        });

        for (let index=0; index < layermax; index++) {
            let layer = new OffscreenCanvas(width,height);
            let ctx = layer.getContext('2d');
            ctx.fillStyle = 'rgb(200, 0, 0)';
            let count = 0;
            widgets.forEach(widget => {
                let slice = widget.slices[index];
                if (slice) {
                    slice.tops.map(top => top.poly).forEach(poly => {
                        ctx.beginPath();
                        poly.forEachPoint((p,i) => {
                            if (i === 0) {
                                ctx.moveTo(p.x + width2, p.y + height2);
                            } else {
                                ctx.lineTo(p.x + width2, p.y + height2);
                            }
                        }, true);
                        ctx.fill();
                        count++;
                    });
                }
            });
            output.push(ctx.getImageData(0,0,width,height));
            update(index / layermax);

            if (count === 0) break;
        }

        // in theory sends back pre-gcode print preview data
        update(1);
    };

    /**
     * DRIVER PRINT CONTRACT - runs in worker
     * @param {Object} print state object
     * @param {Function} online streaming reply
     * @param {Function} ondone last reply
     */
    function printExport(print, online, ondone) {
        let widgets = print.widgets,
            settings = print.settings,
            device = settings.device,
            process = settings.process,
            output = print.output;

        print.images.forEach(image => {
            online(image.data, [image.data.buffer]);
        });

        // in theory converts print data from printSetup to gcode
        // online("pex.line");
        ondone({width:2560,height:1440});
    };

    // runs in browser main
    function printRender(print) {
        let widgets = print.widgets,
            settings = print.settings,
            device = settings.device,
            process = settings.process;

        for (let index=0; ; index++) {
            let layer = KIRI.newLayer(print.group);
            print.printView.push(layer);

            let count = 0;
            widgets.forEach(widget => {
                let slice = widget.slices[index];
                if (!slice) {
                    return;
                }
                slice.tops.map(top => top.poly).forEach(poly => {
                    layer.poly(poly, 0x888888, true, false);
                    count++;
                });
            });
            layer.render();

            if (count === 0) {
                // TODO fix with contract for exposing layer count
                // hack uses expected gcode output array in print object
                print.output = print.printView;
                break;
            }
        }
    }

    // runs in browser main
    function printDownload(API, lines, done) {
        let filename = "print-"+(new Date().getTime().toString(36));

        API.ajax("/kiri/output-sla.html", html => {
            API.ui.print.innerHTML = html;
            $('print-filename').value = filename;
            $('print-layers').value = lines.length;
            $('print-close').onclick = API.modal.hide;
            $('print-photons').onclick = download_photons;
            $('print-photon').onclick = download_photon;
            $('print-pws').onclick = download_pws;

            let canvas = $('print-canvas');
            let ctx = canvas.getContext('2d');
            let img = ctx.createImageData(done.width, done.height);

            let range = $('print-range');
            range.value = 0;
            range.min = 0;
            range.max = lines.length;
            range.oninput = function() {
                console.log(range.value);
                lines[range.value].forEach((v,i) => img.data[i] = v);
                ctx.putImageData(img,0,0);
            };

            API.modal.show('print');
        });
    }

    function download_photons() { }
    function download_photon() { }
    function download_pws() { }

})();