import ts from 'typescript';

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function parameterIdentifiers(pattern, result = []) {
  switch (pattern.type) {
    case 'Identifier':
      if (pattern.name !== 'this') {
        result.push(pattern);
      }
      break;
    case 'RestElement':
      parameterIdentifiers(pattern.argument, result);
      break;
    case 'AssignmentPattern':
      parameterIdentifiers(pattern.left, result);
      break;
    case 'ArrayPattern':
      for (const element of pattern.elements) {
        if (element) {
          parameterIdentifiers(element, result);
        }
      }
      break;
    case 'ObjectPattern':
      for (const property of pattern.properties) {
        parameterIdentifiers(property.type === 'RestElement' ? property.argument : property.value, result);
      }
      break;
    default:
      break;
  }
  return result;
}

function publicClassMember(member) {
  return member.accessibility !== 'private' && member.accessibility !== 'protected' && member.key?.type !== 'PrivateIdentifier';
}

function contractMemberName(member) {
  return member.key?.name ?? member.key?.value;
}

function localInterfaceDeclaresMember(classNode, member, program) {
  const heritage = classNode.implements ?? (classNode.superClass ? [{ expression: classNode.superClass }] : []);
  if (!heritage?.length) {
    return false;
  }
  const names = new Set(heritage.map(({ expression }) => expression?.name).filter(Boolean));
  return program.body.some((statement) =>
    (statement.type === 'TSInterfaceDeclaration' && names.has(statement.id.name)
      || statement.type === 'ClassDeclaration' && names.has(statement.id?.name))
    && statement.body.body.some((declaration) => contractMemberName(declaration) === contractMemberName(member)));
}

function hasExplicitJSDocType(node, sourceCode) {
  const comment = sourceCode.getJSDocComment(node);
  if (!comment) return false;
  const parsed = ts.createSourceFile(
    'jsdoc-contract.js',
    `${sourceCode.getText(comment)}\nconst value = {};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const declaration = parsed.statements.find(ts.isVariableStatement)?.declarationList.declarations[0];
  return Boolean(declaration && ts.getJSDocTypeTag(declaration)?.typeExpression?.type);
}

function contextualContract(fn, context) {
  const services = context.sourceCode.parserServices;
  const program = services?.program;
  if (program && services.esTreeNodeToTSNodeMap) {
    const ts = services.esTreeNodeToTSNodeMap.get(fn);
    const checker = program.getTypeChecker();
    const parent = fn.parent;
    if (parent?.type === 'MethodDefinition') {
      const classNode = parent.parent?.parent;
      const classTs = services.esTreeNodeToTSNodeMap.get(classNode);
      for (const clause of classTs?.heritageClauses ?? []) {
        const methodName = parent.key.name ?? parent.key.value;
        for (const heritageType of clause.types) {
          const type = checker.getTypeAtLocation(heritageType);
          if (type.getProperty(methodName)) return true;
        }
      }
    }
    const contextualType = checker.getContextualType(ts);
    if (contextualType?.getCallSignatures().length) return true;
  }

  const member = fn.parent?.type === 'MethodDefinition' ? fn.parent : undefined;
  if (member && localInterfaceDeclaresMember(member.parent.parent, member, context.sourceCode.ast)) return true;

  const variable = fn.parent?.type === 'VariableDeclarator' ? fn.parent : undefined;
  if (variable?.id.typeAnnotation?.typeAnnotation) return true;
  if (fn.parent?.type === 'TSSatisfiesExpression') return true;
  if (fn.parent?.parent?.type === 'TSSatisfiesExpression') return true;
  if (hasExplicitJSDocType(fn, context.sourceCode)) return true;
  return false;
}

function callablesFromClass(classNode, moduleScope, visited) {
  if (!classNode?.body?.body) {
    return [];
  }
  return classNode.body.body.flatMap((member) => {
    if (!publicClassMember(member)) {
      return [];
    }
    if (member.type === 'MethodDefinition') {
      return callablesFromExpression(member.value, moduleScope, visited);
    }
    if (member.type === 'PropertyDefinition' || member.type === 'FieldDefinition') {
      return callablesFromExpression(member.value, moduleScope, visited);
    }
    return [];
  });
}

function callablesFromObject(objectNode, moduleScope, visited) {
  return objectNode.properties.flatMap((property) => {
    if (property.type === 'SpreadElement') {
      return callablesFromExpression(property.argument, moduleScope, visited);
    }
    if (property.type !== 'Property') {
      return [];
    }
    return callablesFromExpression(property.value, moduleScope, visited);
  });
}

function callablesFromExpression(node, moduleScope, visited = new Set()) {
  if (!node || visited.has(node)) {
    return [];
  }
  visited.add(node);

  if (FUNCTION_TYPES.has(node.type)) {
    return [node];
  }
  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    return callablesFromClass(node, moduleScope, visited);
  }
  if (node.type === 'ObjectExpression') {
    return callablesFromObject(node, moduleScope, visited);
  }
  if (node.type === 'Identifier') {
    const variable = moduleScope.set.get(node.name);
    return (variable?.defs ?? []).flatMap((definition) => {
      const definedNode = definition.node;
      if (definedNode.type === 'VariableDeclarator') {
        return callablesFromExpression(definedNode.init, moduleScope, visited);
      }
      if (definedNode.type === 'FunctionDeclaration' || definedNode.type === 'ClassDeclaration') {
        return callablesFromExpression(definedNode, moduleScope, visited);
      }
      return [];
    });
  }
  return [];
}

function callablesFromDeclaration(declaration, moduleScope) {
  if (!declaration) {
    return [];
  }
  if (declaration.type === 'VariableDeclaration') {
    return declaration.declarations.flatMap(({ init }) => callablesFromExpression(init, moduleScope));
  }
  return callablesFromExpression(declaration, moduleScope);
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'reject unused parameters in exported functions',
    },
    schema: [],
    messages: {
      unused: "Exported parameter '{{name}}' is unused; remove it from the public signature.",
    },
  },
  create(context) {
    const checkedFunctions = new Set();

    function checkFunction(fn) {
      if (!fn?.body || checkedFunctions.has(fn)) {
        return;
      }
      checkedFunctions.add(fn);

      if (contextualContract(fn, context)) return;

      const functionScope = context.sourceCode.getScope(fn);
      for (const param of fn.params) {
        for (const identifier of parameterIdentifiers(param)) {
          const variable = functionScope.set.get(identifier.name);
          if (variable && !variable.references.some((reference) => reference.isRead())) {
            context.report({
              node: identifier,
              messageId: 'unused',
              data: { name: identifier.name },
            });
          }
        }
      }
    }

    function checkDeclaration(declaration, moduleScope) {
      for (const fn of callablesFromDeclaration(declaration, moduleScope)) {
        checkFunction(fn);
      }
    }

    return {
      ExportNamedDeclaration(node) {
        const moduleScope = context.sourceCode.scopeManager.scopes.find((scope) => scope.type === 'module');
        checkDeclaration(node.declaration, moduleScope);
      },
      ExportDefaultDeclaration(node) {
        const moduleScope = context.sourceCode.scopeManager.scopes.find((scope) => scope.type === 'module');
        checkDeclaration(node.declaration, moduleScope);
      },
      'Program:exit'(program) {
        const programScope = context.sourceCode.scopeManager.scopes.find((scope) => scope.type === 'module');
        if (!programScope) {
          return;
        }
        for (const statement of program.body) {
          const isLocalExport = statement.type === 'ExportNamedDeclaration' && statement.source === null;
          const isDefaultIdentifier = statement.type === 'ExportDefaultDeclaration' && statement.declaration.type === 'Identifier';
          if (!isLocalExport && !isDefaultIdentifier) {
            continue;
          }

          const specifiers = isDefaultIdentifier
            ? [{ local: statement.declaration }]
            : statement.specifiers.filter((specifier) => specifier.type === 'ExportSpecifier').map((specifier) => ({ local: specifier.local }));
          for (const specifier of specifiers) {
            for (const fn of callablesFromExpression(specifier.local, programScope)) {
              checkFunction(fn);
            }
          }
        }
      },
    };
  },
};
