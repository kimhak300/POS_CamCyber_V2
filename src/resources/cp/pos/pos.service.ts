// =========================================================================>> Core Library
import { BadRequestException, Injectable } from '@nestjs/common';

// =========================================================================>> Third Party Library
import { Sequelize, Transaction } from 'sequelize';

// =========================================================================>> Custom Library
import sequelizeConfig from 'src/config/sequelize.config';
import User from 'src/models/user/user.model';
import ProductsType from 'src/models/product/type.model';
import Product from 'src/models/product/product.model';
import Order from 'src/models/order/order.model';
import OrderDetails from 'src/models/order/detail.model';
import { TelegramService } from 'src/services/telegram.service';
import { CreateOrderDto } from './pos.dto';

// ======================================= >> Code Starts Here << ========================== //
@Injectable()
export class PosService {

    constructor(private telegramService: TelegramService) { };

    // Method for retrieving products and organizing them by product types
    async getProducts(): Promise<{ data: { id: number, name: string, products: Product[] }[] }> {
        const data = await ProductsType.findAll({
            attributes: ['id', 'name'],
            include: [
                {
                    model: Product,
                    attributes: ['id', 'name', 'image', 'unit_price'],
                },
            ],
            order: [['name', 'ASC']],
        });

        const dataFormat: { id: number, name: string, products: Product[] }[] = data.map(type => ({
            id: type.id,
            name: type.name,
            products: type.products || []
        }));

        return {
            data: dataFormat
        };
    }

    // Method for creating an order
    async makeOrder(cashierId: number, body: CreateOrderDto): Promise<{ data: Order, message: string }> {
        // Initializing DB Connection
        const sequelize = new Sequelize(sequelizeConfig);
        let transaction: Transaction;

        try {
            // Open DB Connection
            transaction = await sequelize.transaction();

            // Create an order
            const order = await Order.create({
                cashier_id: cashierId,
                total_price: 0,
                receipt_number: await this.generateReceiptNumber(),
                ordered_at: null
            }, { transaction });

            // Find Total Price & Order Detail
            let totalPrice = 0;
            const cartItems = JSON.parse(body.cart);

            for (const [productId, qty] of Object.entries(cartItems)) {
                const product = await Product.findByPk(parseInt(productId));

                if (product) {
                    // Save to Details
                    await OrderDetails.create({
                        order_id: order.id,
                        product_id: product.id,
                        qty: Number(qty),
                        unit_price: product.unit_price
                    }, { transaction });

                    totalPrice += Number(qty) * product.unit_price;
                }
            }

            // Update Order with total price and ordered_at timestamp
            await Order.update(
                {
                    total_price: totalPrice,
                    ordered_at: new Date()
                },
                {
                    where: {
                        id: order.id,
                    },
                    transaction,
                }
            );

            // Get Data for Client Response to view the order in Popup
            const data: Order = await Order.findByPk(order.id, {
                attributes: ['id', 'receipt_number', 'total_price', 'ordered_at'],
                include: [
                    {
                        model: User,
                        attributes: ['id', 'name'],
                    },
                    {
                        model: OrderDetails,
                        attributes: ['id', 'unit_price', 'qty'],
                        include: [
                            {
                                model: Product,
                                attributes: ['id', 'name'],
                            }
                        ]
                    },
                ],
                transaction,
            });

            await transaction.commit();

            // Send Telegram Notification
            // Prepare Format
            let htmlMessage = `<b>ការបញ្ជាទិញទទួលបានជោគជ័យ!</b>\n`;
            htmlMessage += `-លេខវិកយប័ត្រ៖ ${data.receipt_number}\n`;
            htmlMessage += `-អ្នកគិតលុយ៖ ${data.cashier?.name || ''}\n`;
            htmlMessage += `-កាលបរិច្ឆេទ: ${data.ordered_at ? new Date(data.ordered_at).toLocaleString() : ''}\n`;
            htmlMessage += `-From NestJS API\n`;
            // Send
            await this.telegramService.sendHTMLMessage(htmlMessage);

            return {
                data: data,
                message: 'ការបញ្ជាទិញត្រូវបានបង្កើតដោយជោគជ័យ។',
            };

        } catch (error) {
            if (transaction) {
                await transaction.rollback();
            }

            // Handle specific errors, if needed
            console.error('Error during order creation:', error);

            throw new BadRequestException('Something went wrong!. Please try again later.', 'Error during order creation.');
        }
    }

    // Private method to generate a unique receipt number
    private async generateReceiptNumber(): Promise<number> {
        const number = Math.floor(Math.random() * 9000000) + 1000000;
        return await Order.findOne({
            where: {
                receipt_number: number,
            },
        }).then((order) => {
            if (order) {
                return this.generateReceiptNumber();
            }
            return number;
        });
    }
}
