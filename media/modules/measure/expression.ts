"use strict";

/**
 * A tiny arithmetic expression evaluator for derived measurement columns.
 *
 * Written as a recursive-descent parser rather than `new Function`, for two
 * reasons: the webview runs under a Content Security Policy that forbids
 * `unsafe-eval`, and a stored expression that ships in a JSON sidecar must not
 * be able to execute anything when that sidecar is opened on another machine.
 *
 * Grammar:
 *
 *     expression := term (('+' | '-') term)*
 *     term       := factor (('*' | '/' | '%') factor)*
 *     factor     := unary ('^' factor)?          -- right associative
 *     unary      := ('-' | '+') unary | primary
 *     primary    := number | identifier | call | '(' expression ')'
 *     call       := identifier '(' [expression (',' expression)*] ')'
 */

export type ExpressionScope = Record<string, number>;

interface Token {
	kind: 'number' | 'name' | 'op';
	value: string;
	position: number;
}

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
	abs: Math.abs,
	sqrt: Math.sqrt,
	log: Math.log,
	log10: Math.log10,
	log2: Math.log2,
	exp: Math.exp,
	min: Math.min,
	max: Math.max,
	pow: Math.pow,
	round: Math.round,
	floor: Math.floor,
	ceil: Math.ceil,
	sin: Math.sin,
	cos: Math.cos,
	tan: Math.tan,
	atan2: Math.atan2,
	sign: Math.sign,
};

const CONSTANTS: Record<string, number> = {
	pi: Math.PI,
	e: Math.E,
};

export class ExpressionError extends Error {
	position: number;
	constructor(message: string, position: number) {
		super(message);
		this.name = 'ExpressionError';
		this.position = position;
	}
}

function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < input.length) {
		const ch = input[i];
		if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
		if ((ch >= '0' && ch <= '9') || (ch === '.' && /[0-9]/.test(input[i + 1] || ''))) {
			let j = i;
			while (j < input.length && /[0-9.]/.test(input[j])) { j++; }
			// Scientific notation, e.g. 1e-3.
			if (j < input.length && (input[j] === 'e' || input[j] === 'E')) {
				let k = j + 1;
				if (input[k] === '+' || input[k] === '-') { k++; }
				if (/[0-9]/.test(input[k] || '')) {
					while (k < input.length && /[0-9]/.test(input[k])) { k++; }
					j = k;
				}
			}
			tokens.push({ kind: 'number', value: input.slice(i, j), position: i });
			i = j;
			continue;
		}
		if (/[A-Za-z_]/.test(ch)) {
			let j = i;
			while (j < input.length && /[A-Za-z0-9_.]/.test(input[j])) { j++; }
			tokens.push({ kind: 'name', value: input.slice(i, j), position: i });
			i = j;
			continue;
		}
		if ('+-*/%^(),'.includes(ch)) {
			tokens.push({ kind: 'op', value: ch, position: i });
			i++;
			continue;
		}
		throw new ExpressionError(`Unexpected character "${ch}"`, i);
	}
	return tokens;
}

/** Compile once, evaluate per row. */
export function compileExpression(source: string): (scope: ExpressionScope) => number {
	const tokens = tokenize(source);
	let cursor = 0;

	const peek = (): Token | undefined => tokens[cursor];
	const expect = (value: string): void => {
		const token = tokens[cursor];
		if (!token || token.value !== value) {
			throw new ExpressionError(`Expected "${value}"`, token ? token.position : source.length);
		}
		cursor++;
	};

	type Node = (scope: ExpressionScope) => number;

	const parseExpression = (): Node => {
		let left = parseTerm();
		for (;;) {
			const token = peek();
			if (!token || token.kind !== 'op' || (token.value !== '+' && token.value !== '-')) { break; }
			cursor++;
			const right = parseTerm();
			const previous = left;
			left = token.value === '+'
				? scope => previous(scope) + right(scope)
				: scope => previous(scope) - right(scope);
		}
		return left;
	};

	const parseTerm = (): Node => {
		let left = parseFactor();
		for (;;) {
			const token = peek();
			if (!token || token.kind !== 'op' || !'*/%'.includes(token.value)) { break; }
			cursor++;
			const right = parseFactor();
			const previous = left;
			if (token.value === '*') { left = scope => previous(scope) * right(scope); }
			else if (token.value === '/') { left = scope => previous(scope) / right(scope); }
			else { left = scope => previous(scope) % right(scope); }
		}
		return left;
	};

	const parseFactor = (): Node => {
		const base = parseUnary();
		const token = peek();
		if (token && token.kind === 'op' && token.value === '^') {
			cursor++;
			const exponent = parseFactor();
			return scope => Math.pow(base(scope), exponent(scope));
		}
		return base;
	};

	const parseUnary = (): Node => {
		const token = peek();
		if (token && token.kind === 'op' && (token.value === '-' || token.value === '+')) {
			cursor++;
			const operand = parseUnary();
			return token.value === '-' ? scope => -operand(scope) : operand;
		}
		return parsePrimary();
	};

	const parsePrimary = (): Node => {
		const token = peek();
		if (!token) { throw new ExpressionError('Unexpected end of expression', source.length); }

		if (token.kind === 'number') {
			cursor++;
			const value = parseFloat(token.value);
			if (!Number.isFinite(value)) { throw new ExpressionError(`Invalid number "${token.value}"`, token.position); }
			return () => value;
		}

		if (token.kind === 'op' && token.value === '(') {
			cursor++;
			const inner = parseExpression();
			expect(')');
			return inner;
		}

		if (token.kind === 'name') {
			cursor++;
			const name = token.value;
			const next = peek();
			if (next && next.kind === 'op' && next.value === '(') {
				cursor++;
				const args: Node[] = [];
				if (peek() && peek()!.value !== ')') {
					args.push(parseExpression());
					while (peek() && peek()!.value === ',') { cursor++; args.push(parseExpression()); }
				}
				expect(')');
				const fn = FUNCTIONS[name.toLowerCase()];
				if (!fn) { throw new ExpressionError(`Unknown function "${name}"`, token.position); }
				return scope => fn(...args.map(arg => arg(scope)));
			}
			const constant = CONSTANTS[name.toLowerCase()];
			if (constant !== undefined) { return () => constant; }
			// Unresolved identifiers evaluate to NaN rather than throwing: a
			// column that is empty for one ROI kind must not break the whole table.
			return scope => {
				const value = scope[name];
				return typeof value === 'number' ? value : NaN;
			};
		}

		throw new ExpressionError(`Unexpected token "${token.value}"`, token.position);
	};

	const root = parseExpression();
	if (cursor < tokens.length) {
		throw new ExpressionError(`Unexpected token "${tokens[cursor].value}"`, tokens[cursor].position);
	}
	return root;
}

/** Names an expression references, for showing which columns it depends on. */
export function expressionDependencies(source: string): string[] {
	const names = new Set<string>();
	let tokens: Token[];
	try { tokens = tokenize(source); } catch { return []; }
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.kind !== 'name') { continue; }
		const isCall = tokens[i + 1] && tokens[i + 1].value === '(';
		if (isCall) { continue; }
		if (CONSTANTS[token.value.toLowerCase()] !== undefined) { continue; }
		names.add(token.value);
	}
	return Array.from(names);
}
