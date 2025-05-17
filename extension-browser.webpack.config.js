/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check

'use strict';

const path = require('path');

module.exports = {
	target: 'webworker',
	entry: './src/extension.ts',
	output: {
		filename: 'extension.js',
		path: path.resolve(__dirname, 'dist/browser'),
		libraryTarget: 'commonjs'
	},
	resolve: {
		extensions: ['.ts', '.js']
	},
	module: {
		rules: [
			{
				test: /\.ts$/,
				exclude: /node_modules/,
				use: [
					{
						loader: 'ts-loader'
					}
				]
			}
		]
	},
	externals: {
		vscode: 'commonjs vscode'
	}
};
