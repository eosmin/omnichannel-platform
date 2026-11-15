import {
  AccountRole,
  AccountType,
  CashKind,
  FinanceCountryCodes,
  PaymentMethod,
  TaxKind
} from '@platform/core/domain'

import type { FinanceTemplate, TemplateAccount } from './types'

// The starter chart for El Salvador (TDD_18 §3.1): a conventional trading business chart, numbering 1 assets, 2
// liabilities, 3 equity, 4 income, 5 cost of sales, 6 expenses. **[ACCOUNTANT]** The codes and the names are the platform's
// working assumption, not an official chart: the owner's accountant adjusts them before the first real entry (the chart is
// editable data from the moment it is seeded). The design only needs the roles to be mapped.

const header = (
  code: string,
  name: string,
  type: AccountType,
  parentCode: string | null
): TemplateAccount => ({ code, name, type, parentCode, isPostable: false })

const posting = (
  code: string,
  name: string,
  type: AccountType,
  parentCode: string,
  cashKind?: CashKind
): TemplateAccount => ({
  code,
  name,
  type,
  parentCode,
  isPostable: true,
  ...(cashKind === undefined ? {} : { cashKind })
})

const { ASSET, LIABILITY, EQUITY, INCOME, COST_OF_SALES, EXPENSE } = AccountType

export const SvTemplate: FinanceTemplate = {
  countryCode: FinanceCountryCodes.EL_SALVADOR,
  accounts: [
    header('1', 'Activo', ASSET, null),
    header('11', 'Efectivo y equivalentes', ASSET, '1'),
    posting('1101', 'Caja general', ASSET, '11', CashKind.CASH),
    posting('1102', 'Caja chica', ASSET, '11', CashKind.CASH),
    header('1110', 'Bancos', ASSET, '11'),
    posting('111001', 'Banco principal', ASSET, '1110', CashKind.BANK),
    header('1120', 'Billeteras digitales', ASSET, '11'),
    posting('112001', 'Billetera digital principal', ASSET, '1120', CashKind.WALLET),
    header('12', 'Cuentas por cobrar', ASSET, '1'),
    posting('1201', 'Por cobrar a transportistas (contra entrega)', ASSET, '12'),
    header('13', 'Inventarios', ASSET, '1'),
    posting('1301', 'Inventario de mercadería', ASSET, '13'),
    posting('1302', 'Inventario en tránsito', ASSET, '13'),
    header('14', 'Impuestos por recuperar', ASSET, '1'),
    posting('1401', 'IVA crédito fiscal', ASSET, '14'),
    header('15', 'Anticipos', ASSET, '1'),
    posting('1501', 'Anticipos a proveedores', ASSET, '15'),

    header('2', 'Pasivo', LIABILITY, null),
    header('21', 'Cuentas por pagar', LIABILITY, '2'),
    posting('2101', 'Proveedores', LIABILITY, '21'),
    posting('2102', 'Transportistas', LIABILITY, '21'),
    header('22', 'Impuestos por pagar', LIABILITY, '2'),
    posting('2201', 'IVA débito fiscal', LIABILITY, '22'),
    posting('2202', 'Otros impuestos por pagar', LIABILITY, '22'),
    header('23', 'Anticipos de clientes', LIABILITY, '2'),
    posting('2301', 'Anticipos de clientes', LIABILITY, '23'),

    header('3', 'Patrimonio', EQUITY, null),
    posting('3101', 'Capital', EQUITY, '3'),
    posting('3102', 'Utilidades acumuladas', EQUITY, '3'),
    posting('3103', 'Saldos de apertura', EQUITY, '3'),

    header('4', 'Ingresos', INCOME, null),
    posting('4101', 'Ventas de productos', INCOME, '4'),
    posting('4102', 'Ingresos por envío', INCOME, '4'),
    posting('4103', 'Descuentos sobre ventas', INCOME, '4'),
    posting('4104', 'Devoluciones sobre ventas', INCOME, '4'),
    posting('4105', 'Otros ingresos', INCOME, '4'),
    posting('4106', 'Ganancia por inventario', INCOME, '4'),

    header('5', 'Costo de ventas', COST_OF_SALES, null),
    posting('5101', 'Costo de mercadería vendida', COST_OF_SALES, '5'),

    header('6', 'Gastos', EXPENSE, null),
    posting('6101', 'Fletes y envíos', EXPENSE, '6'),
    posting('6102', 'Comisiones de transportistas', EXPENSE, '6'),
    posting('6103', 'Comisiones bancarias', EXPENSE, '6'),
    posting('6104', 'Mercadeo y publicidad', EXPENSE, '6'),
    posting('6105', 'Alquileres', EXPENSE, '6'),
    posting('6106', 'Servicios', EXPENSE, '6'),
    posting('6107', 'Planilla', EXPENSE, '6'),
    posting('6108', 'Impuestos y tasas', EXPENSE, '6'),
    posting('6109', 'Pérdidas de inventario', EXPENSE, '6'),
    posting('6110', 'Diferencias de contra entrega', EXPENSE, '6'),
    posting('6111', 'Redondeo', EXPENSE, '6'),
    posting('6112', 'Gastos sin categoría', EXPENSE, '6')
  ],
  roles: {
    [AccountRole.CASH_DEFAULT]: '1101',
    [AccountRole.BANK_DEFAULT]: '111001',
    [AccountRole.INVENTORY]: '1301',
    [AccountRole.INVENTORY_IN_TRANSIT]: '1302',
    [AccountRole.RECEIVABLE_CARRIERS]: '1201',
    [AccountRole.CUSTOMER_ADVANCES]: '2301',
    [AccountRole.PAYABLE_SUPPLIERS]: '2101',
    [AccountRole.PAYABLE_CARRIERS]: '2102',
    [AccountRole.VAT_OUTPUT]: '2201',
    [AccountRole.VAT_INPUT]: '1401',
    [AccountRole.SALES_REVENUE]: '4101',
    [AccountRole.SHIPPING_REVENUE]: '4102',
    [AccountRole.SALES_DISCOUNTS]: '4103',
    [AccountRole.SALES_RETURNS]: '4104',
    [AccountRole.COST_OF_GOODS_SOLD]: '5101',
    [AccountRole.INVENTORY_LOSS]: '6109',
    [AccountRole.INVENTORY_GAIN]: '4106',
    [AccountRole.CARRIER_FREIGHT_EXPENSE]: '6101',
    [AccountRole.CARRIER_COMMISSION_EXPENSE]: '6102',
    [AccountRole.COD_DIFFERENCES]: '6110',
    [AccountRole.OPENING_EQUITY]: '3103',
    [AccountRole.ROUNDING]: '6111',
    [AccountRole.UNCATEGORIZED_EXPENSE]: '6112'
  },
  paymentMethods: {
    [PaymentMethod.CASH]: '1101',
    [PaymentMethod.TRANSFER]: '111001',
    [PaymentMethod.CARD]: '111001',
    [PaymentMethod.OTHER]: '1101'
  },
  // **[ACCOUNTANT]** 13 % is the platform's working assumption for the value added tax (TDD_18 §7, §13 row 2): one rate for every
  // product, with the exempt flag of the product for what does not carry it. The rate is editable data from the moment it is seeded.
  taxRates: [
    {
      code: 'IVA',
      name: 'IVA 13 %',
      rateBps: 1300,
      kind: TaxKind.VAT,
      outputRole: AccountRole.VAT_OUTPUT,
      inputRole: AccountRole.VAT_INPUT,
      isDefault: true
    }
  ],
  // **[ACCOUNTANT]** whether the carrier's shipping fee carries the tax: taxed until the accountant says otherwise
  shippingTaxed: true
}
