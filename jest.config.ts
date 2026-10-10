/**
 * For a detailed explanation regarding each configuration property, visit:
 * https://jestjs.io/docs/configuration
 */

import type { Config } from 'jest';

const config: Config = {
    clearMocks: true,
    collectCoverage: true,
    coverageDirectory: 'coverage',
    coveragePathIgnorePatterns: ['/node_modules/'],
    coverageProvider: 'v8',
    moduleDirectories: ['node_modules', 'bower_components', 'shared'],
    moduleFileExtensions: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'node'],
    moduleNameMapper: {
        '\\.(css|less|scss)$': '<rootDir>/__mocks__/styleMock.js',
        '\\.(gif|ttf|eot|svg)$': '<rootDir>/__mocks__/fileMock.js',
        'react-dom/server': '<rootDir>/__mocks__/react-dom-server.js',
        '@deriv-com/translations': '<rootDir>/__mocks__/translation.mock.js',
        '@deriv-com/ui': '<rootDir>/node_modules/@deriv-com/ui',
        '^@/config/(.*)$': '<rootDir>/src/config/$1',
        '^@/external/(.*)$': '<rootDir>/src/external/$1',
        '^@/adapters/(.*)$': '<rootDir>/src/adapters/$1',
        '^@/utils/(.*)$': '<rootDir>/src/utils/$1',
        '^@/components/(.*)$': '<rootDir>/src/components/$1',
        '^@/constants/(.*)$': '<rootDir>/src/constants/$1',
        '^@/hooks/(.*)$': '<rootDir>/src/hooks/$1',
        '^@/stores/(.*)$': '<rootDir>/src/stores/$1',
        '^@/pages/(.*)$': '<rootDir>/src/pages/$1',
        '^@/services/(.*)$': '<rootDir>/src/services/$1',
    },
    preset: 'ts-jest',
    rootDir: __dirname,
    setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
    testEnvironment: 'jsdom',
    testMatch: ['**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[jt]s?(x)'],
    transform: {
        '^.+\\.(ts|tsx)$': 'ts-jest',
        '^.+\\.(js|jsx)$': 'babel-jest',
        '^.+\\.xml$': 'jest-transform-stub',
    },
    transformIgnorePatterns: ['/node_modules/(?!@deriv-com/ui).+\\.js$'],
};

export default config;
