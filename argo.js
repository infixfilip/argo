/*!
 * Argo.js v0.0-pre
 * Copyright 2011 Filip Salomonsson
 * Argo.js is freely distributable under the MIT license.
 */
(function() {
    var Argo = (typeof this.exports === "object") ?
        this.exports : (this.Argo = {});

        Argo.VERSION = "0.0-pre";

    // Extend an object with the properties of another.
    function extend(obj, props) {
        for (var prop in props) obj[prop] = props[prop];
        return obj;
    }

    // Return a shallow copy of an object.
    function clone(obj) { return extend({}, obj); }

    // Apply func to each element in arr and return the results.
    function map(arr, func) {
        var i, len=arr.length, out = [];
        for (i = 0; i < len; i++) out.push(func(arr[i]));
        return out;
    }

    // Look up a value in context. Path is an array of names.
    function lookup(context, path) {
        var value = context.data, i, name;
        for (i = 0; i < path.length; i++) {
            name = path[i];
            if (!value[name]) { return ""; }
            value = value[name];
        }
        return value;
    }

    function NameNode(parser) { this.name = parser.read_word(); }
    NameNode.prototype.render = function(context) { return this.name; };

    function TextNode(parser) { this.text = parser.read(/^[^{]+/); }
    TextNode.prototype.render = function(context) { return this.text; };

    function ValueNode(parser) {
        var path = [], filters = [];
        path.push(parser.read_word());
        while (parser.peek(".")) {
            parser.read(".");
            path.push(parser.read_word());
        }
        while (parser.peek("|")) {
            this.read("|");
            filters.push(parser.read_word());
        }

        this.path = path;
        this.filters = filters;
    }
    ValueNode.prototype.render = function(context) {
            return lookup(context, this.path);
    };
    
    function ConditionNode(parser) {
        var ors = this.ors = [], ands = [];
        parser.read();
        // Read into an array of arrays.
        // The members of each second-level array are and-ed, and the
        // resulting values are in turn or-ed
        // We don't handle parenthesized expressions; use nested ifs for that.
        
        // (a and b) or (c and d and e) or (f)
        for (;;) {
            ands.push(new ValueNode(parser));
            parser.read();
            while (parser.peek("and")) {
                parser.read("and"); parser.read();
                ands.push(new ValueNode(parser));
                parser.read();
            }
            if (parser.peek("or")) {
                parser.read("or"); parser.read();
                ors.push(ands);
                ands = [];
            } else { break; }
        }
        if (ands.length > 0) { ors.push(ands); }
    }
    ConditionNode.prototype.render = function(context) {
        var i, j, group, result = false, orlen = this.ors.length, andlen;
        for (i = 0; i < orlen; i++) {
            group = true;
            for (j = 0, andlen = this.ors[i].length; j < andlen; j++) {
                group = group && this.ors[i][j].render(context);;
                if (!group) { break; }
            }
            result = result || group
            if (result) { break; }
        }
        return !!result;
    };
    
    function TagNode(parser) {
        var name = parser.read_word(),
        args = this.args = [],
        tag = this.tag = Argo.tags[name],
        tagargs = tag.args, tagargslen=tagargs.length, i, ArgNode;
        if (!tag) { parser.error("Unknown tag: '" + name + "'"); }
        for (i=0; i < tagargslen; i++) {
            ArgNode = tagargs[i];
            parser.read();
            if (typeof ArgNode === "string") {
                parser.read(ArgNode); parser.read();
            } else { args.push(new ArgNode(parser)); }
        }
        this.name = name;
        if (tag.block) {
            this.tree = [];
            this.tree.parent = parser.tree;
            this.tree.name = name
        }
    }
    TagNode.prototype.render = function(context, render) {
            var f = this.tag.render;
            context = {data: clone(context.data), parent: context};
            return f.apply(f, [context, render, this.tree].
                concat(map(this.args, function (arg) {
                    return arg.render(context, render);
                }))).join("");
    };

    /* Template tag definitions */
    Argo.tags = {
        "for": {
            args: [NameNode, "in", ValueNode],
            block: true,
            render: function(context, render, tree, name, value) {
                return map(value, function(item) {
                    context.data[name] = item;
                    return render(tree, context.data);
                });
            }
        },
        "if": {
            args: [ConditionNode],
            block: true,
            render: function(context, render, tree, condition) {
                var i, truetree, falsetree;
                for (i = 0; i < tree.length; i++) {
                    if (tree[i].name === "else") { break; }
                }
                truetree = tree.slice(0, i);
                falsetree = tree.slice(i);
                if (condition) {
                    return [render(truetree, context.data)];
                } else {
                    return [render(falsetree, context.data)];
                }
            }
        },
        "else": {
            args: [],
            block: false,
            verify: function(tree) {
                console.log("Verifying...", tree);
                if (tree.name !== "if") {
                    throw new SyntaxError("Else tag without if!");
                }
            },
            render: function() {return []; }
        }
    };

    /* The parser! This is what turns a template string into a syntax
       tree.
    */
    Argo.TemplateParser = function(s) {
        this.s = s;
        this.pos = 0;
        this.tree = [];
    };
    extend(Argo.TemplateParser.prototype, {
        parse: function() {
            while (this.pos < this.s.length) {
                if (this.peek("{{")) { this.read_print(); }
                else if (this.peek("{%")) { this.read_tag(); }
                else { this.read_text(); }
            }
            return this.tree;
        },
        
        // Peek ahead and either return a string or match it against
        // an expected string or regexp.
        peek: function(what) {
            if (typeof what === "string") {
                return this.s.substr(this.pos, what.length) === what;
            } else if (what instanceof RegExp) {
                return what.test(this.s.slice(this.pos));
            } else {
                return this.s.substr(this.pos, what);
            }
        },

        // Read a string from input and return it. Argument can be either
        // a string or a regexp. With no argument, read a sequence of
        // whitespace. Throw an error if the input doesnt match the string.
        read: function(what) {
            var match;
            what = what || /^\s*/;
            if (what instanceof RegExp) {
                match = what.exec(this.s.slice(this.pos));
                if (!match) { this.error("Expected '" + what + "'"); }
                what = match[0];
            } else if (!this.peek(what)) {
                this.error("Expected '" + what + "'");
            }
            this.pos += what.length;
            return what;
        },
        read_text: function() { this.tree.push(new TextNode(this)); },
        read_word: function() { return this.read(/^[a-z]\w*/); },
        read_literal: function() {
            if (this.peek(/^\d/)) { return this.read(/^\d+(\.\d+)?/); }
            else if (this.peek('"')) {
                return this.read(/^"([^\n"\\]|\\x[0-9a-f]{2}|\\.)*"/);
            }
        },

        read_print: function() {
            this.read("{{"); this.read();
            this.tree.push(new ValueNode(this));
            this.read(); this.read("}}");
        },

        read_tag: function() {
            var name, node;
            this.read("{%"); this.read();
            if (this.peek("/")) {
                this.read("/");
                name = this.read_word();
                if (name !== this.tree.name) {
                    this.error("Expected /" + this.tree.name +
                               ", got /" + name);
                }
                this.tree = this.tree.parent;
            } else {
                var node = new TagNode(this);
                this.tree.push(node);
                if (node.tree) { this.tree = node.tree; }
                if (node.tag.verify) { node.tag.verify(this.tree); }
            }
            this.read(); this.read("%}");
        },
        
        error: function(msg) {
            var lineno = this.s.slice(0, this.pos).split("\n").length;
            if (this.s.charAt(0) === "\n") { lineno -= 1; }
            throw msg + " at line " + lineno + ", near '" + this.s.slice(this.pos-5, this.pos+15) + "'";
        }
    });
    
    Argo.render = function(tree, data) {
        var output = [],
            context = {data: data},
            treelen = tree.length,
            i, node;
        for (i = 0; i < treelen; i++) {
            node = tree[i];
            output.push(node.render(context, Argo.render));
        }
        return output.join("");
    };
    
}());
